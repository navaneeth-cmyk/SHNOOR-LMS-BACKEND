import pool from "../db/postgres.js";
import csv from "csv-parser";
import fs from "fs";
import {
    uploadLocalFileToS3,
    resolveS3StorageFolder,
    removeLocalFileSafe,
} from "../services/s3Storage.service.js";

export const bulkUploadModules = async (req, res) => {
    const client = await pool.connect();
    let csvFile = null;
    let resourceFiles = [];
    let uploadedResourceUrlByName = {};
    let uploadedProviderByName = {};

    try {
        const { courseId } = req.body;
        if (!courseId) {
            return res.status(400).json({ message: "courseId is required" });
        }

        // 1. Files
        csvFile = req.files && req.files['file'] ? req.files['file'][0] : null;
        resourceFiles = req.files && req.files['resources'] ? req.files['resources'] : [];

        if (!csvFile) {
            return res.status(400).json({ message: "CSV file is required" });
        }

        // Map uploaded filenames to their objects for easy lookup
        const fileMap = {};
        resourceFiles.forEach(f => {
            fileMap[f.originalname] = f;
        });

        const results = [];
        const errors = [];

        // 2. Parse CSV
        await new Promise((resolve, reject) => {
            fs.createReadStream(csvFile.path)
                .pipe(csv())
                .on('data', (data) => results.push(data))
                .on('end', resolve)
                .on('error', reject);
        });

        // Clean up temp CSV file after parsing
        fs.unlink(csvFile.path, () => {});

        // 3. Process Rows
        const validModules = [];

        // Get current max order
        const maxOrderRes = await pool.query(
            "SELECT MAX(module_order) as max_order FROM modules WHERE course_id = $1",
            [courseId]
        );
        let currentOrder = (maxOrderRes.rows[0].max_order || 0) + 1;

        for (let i = 0; i < results.length; i++) {
            const row = results[i];
            const rowNum = i + 2; // CSV header is row 1

            // Smart Column Realignment: Check for URLs in wrong columns (common in malformed CSVs)
            if (!row.module_source || !row.module_source.includes('http')) {
                const urlRegex = /(http|https):\/\/[^ "]+$/;

                // Check module_type
                if (row.module_type && urlRegex.test(row.module_type)) {
                    row.module_source = row.module_type;
                    row.module_type = ""; // Will be inferred later
                }
                // Check module_duration
                else if (row.module_duration && urlRegex.test(row.module_duration)) {
                    row.module_source = row.module_duration;
                    row.module_duration = 0;
                }
                // Check module_name (extreme case, but happens)
                else if (row.module_name && urlRegex.test(row.module_name) && !row.module_source) {
                    // If name is the URL, we likely lost the name. 
                    // Use the filename/end of URL as name if helpful, or keep generic.
                    row.module_source = row.module_name;
                    row.module_name = "Untitled Module";
                }
            }

            // Basic Validation - Relaxed: Allow missing type if we have a source to infer from
            if (!row.module_name) {
                errors.push({ row: rowNum, message: "Missing module_name" });
                continue;
            }
            if (!row.module_type && !row.module_source) {
                errors.push({ row: rowNum, message: "Missing module_type and no source to infer from" });
                continue;
            }

            const type = row.module_type.toLowerCase();
            const validTypes = ['video', 'pdf', 'text_stream'];

            // Normalize type if possible (e.g. 'Text Stream' -> 'text_stream')
            let normalizedType = type;
            if (type.includes('text') || type.includes('stream')) normalizedType = 'text_stream';
            else if (type.includes('video')) normalizedType = 'video';
            else if (type.includes('pdf')) normalizedType = 'pdf';

            if (!validTypes.includes(normalizedType)) {
                // Try to infer from module_source if type is invalid or missing
                const source = (row.module_source || "").toLowerCase();
                if (source.includes('gamma.app')) normalizedType = 'video';
                else if (source.includes('youtube.com') || source.includes('youtu.be')) normalizedType = 'video';
                else if (source.includes('.pdf')) normalizedType = 'pdf';
                else if (source.includes('.mp4') || source.includes('.webm')) normalizedType = 'video';
                else if (source.includes('.txt') || source.includes('.html')) normalizedType = 'text_stream';

                if (!validTypes.includes(normalizedType)) {
                    errors.push({ row: rowNum, message: `Invalid module_type: ${row.module_type}` });
                    continue;
                }
            } else {
                // Priority detection: Even if they said 'pdf', if it's Gamma/YouTube, it should be 'video' for proper embedding
                const source = (row.module_source || "").toLowerCase();
                if (source.includes('gamma.app') || source.includes('youtube.com') || source.includes('youtu.be')) {
                    normalizedType = 'video';
                } else if (source.includes('.pdf') && normalizedType !== 'pdf') {
                    normalizedType = 'pdf';
                }
            }

            // Source Handling
            let contentUrl = row.module_source || "";
            let uploadedFile = null;

            // If source looks like a filename, check if we have it in uploaded resources
            if (contentUrl && !contentUrl.startsWith('http') && fileMap[contentUrl]) {
                const f = fileMap[contentUrl];
                if (!uploadedResourceUrlByName[f.originalname]) {
                    // Use S3 for all file uploads
                    const uploaded = await uploadLocalFileToS3(f.path, {
                        originalName: f.originalname,
                        mimeType: f.mimetype,
                        folder: `modules/${resolveS3StorageFolder({
                            type: normalizedType,
                            mimeType: f.mimetype,
                            originalName: f.originalname,
                        })}`,
                    });
                    uploadedResourceUrlByName[f.originalname] = uploaded.url;
                    uploadedProviderByName[f.originalname] = "s3";
                }
                contentUrl = uploadedResourceUrlByName[f.originalname];
                uploadedFile = f;
            }

            // Duration
            const duration = row.module_duration ? parseInt(row.module_duration) : 0;

            validModules.push({
                title: row.module_name,
                type: normalizedType,
                content_url: contentUrl,
                duration,
                notes: row.module_notes || "",
                order_index: currentOrder++,
                rowNum,
                uploadedFile // Keep ref if needed for specialized processing
            });
        }

        if (errors.length > 0) {
            // Optional: Fail valid rows if any errors? 
            // Strategy: Insert valid ones, return errors for invalid.
            // But if user wants "All or Nothing", we should rollback. 
            // Requirement says "Handle Partial failures" in Backend, but "Use transactions: Rollback course modules on critical failure".
            // Let's do ALL OR NOTHING for simplicity and data integrity, or at least return errors. 
            // Prompt says: "Clean separation... Handle Partial failures... Row-level errors".
            // Let's proceed with Valid modules and report errors.
        }

        if (validModules.length === 0) {
            return res.status(400).json({
                message: "No valid modules found in CSV",
                errors
            });
        }

        await client.query('BEGIN');

        let createdCount = 0;

        for (const m of validModules) {
            // Special handling for text_stream if it needs chunking NOW
            // Reuse logic? moduleController.js logic is embedded in addModules.
            // Ideally we refactor 'chunking' logic to a service. 
            // For now, I will simplify: Text Stream via Bulk will treat content_url as the source file.
            // The `getModuleStream` logic handles lazy loading or we need to pre-chunk.
            // In `addModules` (moduleController.js), checking lines 49-160, it DOES pre-chunk.
            // I should duplicate that logic or extract it.
            // DUPLICATING logic for safety within this artifact to avoid breaking existing controller refactor risk.

            if (m.type === 'text_stream' && m.content_url) {
                let textContent = "";
                const isHtmlFile = m.uploadedFile?.originalname.toLowerCase().endsWith('.html') || m.content_url.toLowerCase().endsWith('.html');

                if (m.uploadedFile && !isHtmlFile) {
                    try {
                        textContent = fs.readFileSync(m.uploadedFile.path, 'utf-8');
                    } catch (readErr) {
                        console.error('Error reading text file from disk:', readErr.message);
                    }
                }
                // If it's a URL, we can't easily chunk it unless we fetch it. 
                // Assuming Bulk Upload implies they provide the file.

                if (textContent && !isHtmlFile) {
                    // Strip HTML if pseudo-HTML (though we checked isHtmlFile, this is for safety)
                    if (m.uploadedFile?.originalname.endsWith('.html')) {
                        // ✅ DO NOT strip HTML tags - preserve them for iframe display
                        // textContent = textContent.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
                    }

                    if (textContent) {
                        const chunks = textContent.split(/\s+/).filter(c => c.length > 0).map(c => c + " ");

                        // Insert Module
                        const newMod = await client.query(
                            `INSERT INTO modules (course_id, title, type, content_url, module_order, duration_mins, notes)
                              VALUES ($1, $2, 'text_stream', $3, $4, $5, $6)
                              RETURNING module_id`,
                            [courseId, m.title, m.content_url, m.order_index, m.duration, m.notes]
                        );
                        const moduleId = newMod.rows[0].module_id;

                        // Insert Chunks
                        const values = [];
                        const placeholders = [];
                        for (let k = 0; k < chunks.length; k++) {
                            values.push(moduleId, chunks[k], k, 1);
                            const offset = k * 4;
                            placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`);
                        }

                        // Bulk insert chunks (beware large query limits, maybe chunk the chunks?)
                        if (values.length > 0) {
                            const chunkLimit = 1000; // rows per insert
                            for (let j = 0; j < placeholders.length; j += chunkLimit) {
                                const pChunk = placeholders.slice(j, j + chunkLimit);
                                // We need to slice values too, but values relies on flattened structure.
                                // Actually, let's just loop and insert or use logical batching.
                                // Simplest: Just use loop above to build smaller batches.
                            }
                            // Re-doing batch logic properly:

                            const batchSize = 500;
                            for (let b = 0; b < chunks.length; b += batchSize) {
                                const batchChunks = chunks.slice(b, b + batchSize);
                                const bValues = [];
                                const bPlaceholders = [];

                                batchChunks.forEach((chunk, idx) => {
                                    const absIdx = b + idx;
                                    bValues.push(moduleId, chunk, absIdx, 1);
                                    const off = idx * 4;
                                    bPlaceholders.push(`($${off + 1}, $${off + 2}, $${off + 3}, $${off + 4})`);
                                });

                                const q = `INSERT INTO module_text_chunks (module_id, content, chunk_order, duration_seconds) VALUES ${bPlaceholders.join(', ')}`;
                                await client.query(q, bValues);
                            }
                        }
                        createdCount++;
                        continue;
                    }
                }
            }

            // Standard Insert
            await client.query(
                `INSERT INTO modules (course_id, title, type, content_url, duration_mins, module_order, notes)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [courseId, m.title, m.type, m.content_url, m.duration, m.order_index, m.notes]
            );
            createdCount++;
        }

        await client.query('COMMIT');

        // Clean up CSV file (auto-deleted by OS eventually or explicitly?)
        // filesystem cleanup is good practice but optional here.

        res.status(200).json({
            message: "Bulk module upload processed",
            successCount: createdCount,
            errors,
            totalRows: results.length
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Bulk Module Upload Error:", err);
        res.status(500).json({ message: "Server error during bulk upload", error: err.message });
    } finally {
        if (csvFile?.path) {
            await removeLocalFileSafe(csvFile.path);
        }
        for (const file of resourceFiles) {
            const provider = uploadedProviderByName[file?.originalname];
            if (!provider || provider === "supabase") {
                await removeLocalFileSafe(file?.path);
            }
        }
        client.release();
    }
};