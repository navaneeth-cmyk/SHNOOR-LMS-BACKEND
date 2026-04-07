import admin from "../services/firebaseAdmin.js";
import pool from "../db/postgres.js";
import { sendInstructorInvite, generatePasswordResetLink } from "../services/email.service.js";
import { validateInstructorData } from "../utils/validation.js";
import { Readable } from "stream";
import csvParser from "csv-parser";

const defaultFrontendUrl = (process.env.FRONTEND_URL || "https://lms.shnoor.com").replace(/\/$/, "");

/**
 * Parse CSV buffer into array of objects
 */
const parseCSV = (buffer) => {
  return new Promise((resolve, reject) => {
    const results = [];
    const errors = [];
    let rowNumber = 1; // Start at 1 for header

    const stream = Readable.from(buffer.toString());

    stream
      .pipe(csvParser({
        skipEmptyLines: true,
        trim: true,
      }))
      .on('data', (data) => {
        rowNumber++;
        results.push({ ...data, rowNumber });
      })
      .on('error', (error) => {
        reject(error);
      })
      .on('end', () => {
        resolve(results);
      });
  });
};

/**
 * Bulk upload instructors from CSV
 */
export const bulkUploadInstructors = async (req, res) => {
  try {
    // Check if file was uploaded
    if (!req.file) {
      return res.status(400).json({
        message: "No CSV file uploaded",
      });
    }

    console.log(`📂 Processing CSV file: ${req.file.originalname} (${req.file.size} bytes)`);

    // Parse CSV
    let instructors;
    try {
      instructors = await parseCSV(req.file.buffer);
    } catch (parseError) {
      console.error("CSV Parse Error:", parseError);
      return res.status(400).json({
        message: "Failed to parse CSV file",
        error: parseError.message,
      });
    }

    if (instructors.length === 0) {
      return res.status(400).json({
        message: "CSV file is empty or invalid",
      });
    }

    console.log(`📊 Found ${instructors.length} instructors to process`);

    // Step 1: Validate all rows first
    const validationResults = [];
    const validInstructors = [];
    const invalidRows = [];

    for (const row of instructors) {
      const validation = validateInstructorData({
        fullName: row.fullName || row.full_name || row.name,
        email: row.email,
        subject: row.subject || row.specialization,
        phone: row.phone || '',
        bio: row.bio || '',
      });

      if (validation.valid) {
        validInstructors.push({
          ...validation.data,
          rowNumber: row.rowNumber,
        });
      } else {
        invalidRows.push({
          rowNumber: row.rowNumber,
          data: row,
          errors: validation.errors,
        });
      }
    }

    console.log(`✅ Valid: ${validInstructors.length}, ❌ Invalid: ${invalidRows.length}`);

    // If there are validation errors, return them
    if (invalidRows.length > 0) {
      return res.status(400).json({
        message: `Validation failed for ${invalidRows.length} row(s)`,
        invalidRows,
        validCount: validInstructors.length,
        totalCount: instructors.length,
      });
    }

    // Step 2: Check for duplicate emails in CSV
    const emailsInCSV = new Set();
    const duplicatesInCSV = [];

    for (const instructor of validInstructors) {
      if (emailsInCSV.has(instructor.email)) {
        duplicatesInCSV.push({
          rowNumber: instructor.rowNumber,
          email: instructor.email,
          error: "Duplicate email within CSV",
        });
      } else {
        emailsInCSV.add(instructor.email);
      }
    }

    if (duplicatesInCSV.length > 0) {
      return res.status(400).json({
        message: `Found ${duplicatesInCSV.length} duplicate email(s) within CSV`,
        duplicates: duplicatesInCSV,
      });
    }

    // Step 3: Check for existing emails in database
    const emails = validInstructors.map(i => i.email);
    const existingCheck = await pool.query(
      `SELECT email FROM users WHERE email = ANY($1)`,
      [emails]
    );

    const existingEmails = new Set(existingCheck.rows.map(r => r.email));
    const duplicatesInDB = validInstructors.filter(i => 
      existingEmails.has(i.email)
    ).map(i => ({
      rowNumber: i.rowNumber,
      email: i.email,
      error: "Email already exists in database",
    }));

    if (duplicatesInDB.length > 0) {
      return res.status(409).json({
        message: `Found ${duplicatesInDB.length} email(s) that already exist in database`,
        duplicates: duplicatesInDB,
      });
    }

    // Step 4: Process each instructor with transaction
    const results = {
      successful: [],
      failed: [],
    };

    for (const instructor of validInstructors) {
      const client = await pool.connect();
      
      try {
        await client.query('BEGIN');

        console.log(`📝 Processing row ${instructor.rowNumber}: ${instructor.email}`);

        // Create Firebase user
        let firebaseUser;
        try {
          firebaseUser = await admin.auth().createUser({
            email: instructor.email,
            displayName: instructor.fullName,
          });
          console.log(`✅ Firebase user created: ${firebaseUser.uid}`);
        } catch (firebaseError) {
          throw new Error(`Firebase: ${firebaseError.message}`);
        }

        // Insert into users table
        const userResult = await client.query(
          `INSERT INTO users (firebase_uid, full_name, email, role, status)
           VALUES ($1, $2, $3, 'instructor', 'active')
           RETURNING user_id`,
          [firebaseUser.uid, instructor.fullName, instructor.email]
        );

        const instructorId = userResult.rows[0].user_id;
        console.log(`✅ User record created with ID: ${instructorId}`);

        // Insert into instructor_profiles table
        await client.query(
          `INSERT INTO instructor_profiles (instructor_id, subject, phone, bio)
           VALUES ($1, $2, $3, $4)`,
          [instructorId, instructor.subject, instructor.phone, instructor.bio]
        );

        await client.query('COMMIT');

        results.successful.push({
          rowNumber: instructor.rowNumber,
          email: instructor.email,
          fullName: instructor.fullName,
          userId: instructorId,
        });

        console.log(`✅ Row ${instructor.rowNumber} processed successfully`);

        // Send email (non-blocking, after transaction)
        setImmediate(async () => {
          try {
            const createPasswordUrl = await generatePasswordResetLink(instructor.email);
            await sendInstructorInvite(
              {
                email: instructor.email,
                name: instructor.fullName,
                createPasswordUrl,
                loginUrl: `${defaultFrontendUrl}/login`,
              },
              instructor.fullName,
            );
            console.log(`📧 Email sent to ${instructor.email}`);
          } catch (emailError) {
            console.error(`📧 Email failed for ${instructor.email}:`, emailError.message);
          }
        });

      } catch (error) {
        await client.query('ROLLBACK');
        
        console.error(`❌ Row ${instructor.rowNumber} failed:`, error.message);

        // Cleanup: Delete Firebase user if created
        try {
          if (error.message.includes('Firebase')) {
            // Firebase creation failed, no cleanup needed
          } else {
            // DB failed, cleanup Firebase user
            const firebaseUsers = await admin.auth().getUserByEmail(instructor.email);
            if (firebaseUsers) {
              await admin.auth().deleteUser(firebaseUsers.uid);
              console.log(`🧹 Cleaned up Firebase user for ${instructor.email}`);
            }
          }
        } catch (cleanupError) {
          console.error(`🧹 Cleanup failed for ${instructor.email}:`, cleanupError.message);
        }

        results.failed.push({
          rowNumber: instructor.rowNumber,
          email: instructor.email,
          fullName: instructor.fullName,
          error: error.message,
        });

      } finally {
        client.release();
      }
    }

    // Return results
    const statusCode = results.failed.length === 0 ? 201 : 207; // 207 Multi-Status

    res.status(statusCode).json({
      message: `Processed ${instructors.length} instructor(s)`,
      summary: {
        total: instructors.length,
        successful: results.successful.length,
        failed: results.failed.length,
      },
      results,
    });

  } catch (error) {
    console.error("bulkUploadInstructors error:", error);
    res.status(500).json({ 
      message: "Failed to process bulk upload",
      error: error.message,
    });
  }
};