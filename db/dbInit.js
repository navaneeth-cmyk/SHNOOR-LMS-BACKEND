import pool from './postgres.js';

/**
 * Centrally initializes all required database tables if they don't exist.
 * This ensures the application remains stable even if a developer forgets 
 * to run manual migrations.
 */
export const initializeDatabase = async () => {
    try {
        console.log("🛠️  Initializing Database Tables...");

        // 1. Ensure PGCrypto for UUID generation
        await pool.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');

        // --- Core Tables ---
        console.log("   - Setting up Core Tables (Users, Courses)...");
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                user_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                firebase_uid VARCHAR(255) UNIQUE NOT NULL,
                full_name VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                role VARCHAR(50) NOT NULL,
                status VARCHAR(50) DEFAULT 'pending',
                xp INTEGER DEFAULT 0,
                streak INTEGER DEFAULT 0,
                last_active_date DATE,
                last_login TIMESTAMP,
                college VARCHAR(255),
                photo_url TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Migration: Ensure last_login and streak columns
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS streak INTEGER DEFAULT 0;`).catch(() => {});
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS xp INTEGER DEFAULT 0;`).catch(() => {});
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_date DATE;`).catch(() => {});

        await pool.query(`
            CREATE TABLE IF NOT EXISTS courses (
                courses_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                instructor_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
                title VARCHAR(255) NOT NULL,
                description TEXT,
                category VARCHAR(100),
                thumbnail_url TEXT,
                difficulty VARCHAR(50),
                status VARCHAR(50) DEFAULT 'draft',
                validity_value INTEGER,
                validity_unit VARCHAR(20),
                expires_at TIMESTAMP,
                schedule_start_at TIMESTAMP,
                price_type VARCHAR(20) DEFAULT 'free',
                price_amount DECIMAL(10, 2),
                prereq_description TEXT,
                prereq_video_urls JSONB DEFAULT '[]',
                prereq_pdf_url TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS modules (
                module_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                course_id UUID REFERENCES courses(courses_id) ON DELETE CASCADE,
                title VARCHAR(255) NOT NULL,
                type VARCHAR(50) NOT NULL,
                content_url TEXT,
                s3_object_path TEXT,
                pdf_filename TEXT,
                duration_mins INTEGER DEFAULT 0,
                module_order INTEGER DEFAULT 0,
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Migration: Add s3_object_path column if it doesn't exist
        try {
            await pool.query(`
                ALTER TABLE modules ADD COLUMN IF NOT EXISTS s3_object_path TEXT;
            `);
            console.log("   - s3_object_path column added to modules table");
        } catch (err) {
            console.error("   - Error adding s3_object_path column:", err.message);
        }

        await pool.query(`
            CREATE TABLE IF NOT EXISTS module_progress (
                student_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
                course_id UUID REFERENCES courses(courses_id) ON DELETE CASCADE,
                module_id UUID REFERENCES modules(module_id) ON DELETE CASCADE,
                time_spent_seconds INTEGER DEFAULT 0,
                last_position_seconds INTEGER DEFAULT 0,
                last_accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMP,
                PRIMARY KEY (student_id, module_id)
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS student_courses (
                student_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
                course_id UUID REFERENCES courses(courses_id) ON DELETE CASCADE,
                enrolled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (student_id, course_id)
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS course_assignments (
                assignment_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                student_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
                course_id UUID REFERENCES courses(courses_id) ON DELETE CASCADE,
                assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (student_id, course_id)
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS module_text_chunks (
                chunk_id SERIAL PRIMARY KEY,
                module_id UUID REFERENCES modules(module_id) ON DELETE CASCADE,
                content TEXT NOT NULL,
                chunk_order INTEGER NOT NULL,
                duration_seconds INTEGER DEFAULT 1
            );
        `);

        // 2. Learning Paths Module
        console.log("   - Setting up Learning Paths...");
        await pool.query(`
            CREATE TABLE IF NOT EXISTS learning_paths (
                id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                instructor_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Enforce globally unique learning path names (case-insensitive, trim-aware).
        // If legacy duplicate rows exist, skip index creation to avoid boot failure.
        await pool.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1
                    FROM pg_indexes
                    WHERE schemaname = 'public'
                      AND indexname = 'learning_paths_unique_name_idx'
                ) THEN
                    IF NOT EXISTS (
                        SELECT 1
                        FROM (
                            SELECT lower(trim(name)) AS normalized_name, COUNT(*) AS dup_count
                            FROM learning_paths
                            GROUP BY lower(trim(name))
                            HAVING COUNT(*) > 1
                        ) dups
                    ) THEN
                        CREATE UNIQUE INDEX learning_paths_unique_name_idx
                        ON learning_paths ((lower(trim(name))));
                    ELSE
                        RAISE NOTICE 'Skipping unique index for learning_paths.name due to existing duplicate values';
                    END IF;
                END IF;
            END $$;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS learning_path_courses (
                id SERIAL PRIMARY KEY,
                learning_path_id UUID REFERENCES learning_paths(id) ON DELETE CASCADE,
                course_id UUID REFERENCES courses(courses_id) ON DELETE CASCADE,
                order_index INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(learning_path_id, course_id)
            );
        `);

        // 3. Exams Module
        console.log("   - Setting up Exams...");
        await pool.query(`
            CREATE TABLE IF NOT EXISTS exams (
                exam_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                title VARCHAR(255) NOT NULL,
                description TEXT,
                duration INT NOT NULL, -- in minutes
                pass_percentage INT DEFAULT 40,
                instructor_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
                course_id UUID REFERENCES courses(courses_id) ON DELETE CASCADE,
                validity_value INT,
                validity_unit VARCHAR(20), -- 'days', 'months', 'years'
                disconnect_grace_time INT DEFAULT 300, -- 5 mins grace for power cuts/net loss
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Ensure disconnect_grace_time exists (migration)
        await pool.query(`
            ALTER TABLE exams ADD COLUMN IF NOT EXISTS disconnect_grace_time INTEGER DEFAULT 300;
        `);

        // Ensure status exists (migration for older schemas)
        await pool.query(`
            ALTER TABLE exams ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'approved';
        `).catch(() => {});

        await pool.query(`
            CREATE TABLE IF NOT EXISTS exam_questions (
                question_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                exam_id UUID REFERENCES exams(exam_id) ON DELETE CASCADE,
                question_text TEXT NOT NULL,
                question_type VARCHAR(50) DEFAULT 'mcq', -- mcq, descriptive, coding
                marks INT DEFAULT 1,
                question_order INT DEFAULT 0,
                keywords TEXT, -- for descriptive auto-grading
                min_word_count INT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Ensure question_order exists (migration)
        await pool.query(`
            ALTER TABLE exam_questions ADD COLUMN IF NOT EXISTS question_order INTEGER DEFAULT 0;
        `);


        await pool.query(`
            CREATE TABLE IF NOT EXISTS exam_mcq_options (
                option_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                question_id UUID REFERENCES exam_questions(question_id) ON DELETE CASCADE,
                option_text TEXT NOT NULL,
                is_correct BOOLEAN DEFAULT FALSE,
                option_order INT DEFAULT 0
            );
        `);

        // --- Coding Questions Support ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS exam_coding_questions (
                coding_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                question_id UUID REFERENCES exam_questions(question_id) ON DELETE CASCADE,
                title VARCHAR(255),
                description TEXT,
                language VARCHAR(50),
                starter_code TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS exam_test_cases (
                test_id SERIAL PRIMARY KEY,
                coding_id UUID REFERENCES exam_coding_questions(coding_id) ON DELETE CASCADE,
                input TEXT,
                expected_output TEXT,
                is_hidden BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Migration: Ensure test_id exists
        const checkTestId = await pool.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'exam_test_cases' AND column_name = 'test_id'
        `);

        if (checkTestId.rows.length === 0) {
            console.log("   - Adding test_id to exam_test_cases...");
            // Add as SERIAL first
            await pool.query(`ALTER TABLE exam_test_cases ADD COLUMN test_id SERIAL;`);

            // Now check if there's an existing PK
            const pkCheck = await pool.query(`
                SELECT count(*) FROM pg_index i
                JOIN pg_class c ON c.oid = i.indrelid
                WHERE c.relname = 'exam_test_cases' AND i.indisprimary;
            `);

            if (parseInt(pkCheck.rows[0].count) === 0) {
                console.log("   - No PK found, making test_id the primary key...");
                await pool.query(`ALTER TABLE exam_test_cases ADD PRIMARY KEY (test_id);`);
            }
        }


        await pool.query(`
            CREATE TABLE IF NOT EXISTS exam_attempts (
                exam_id UUID REFERENCES exams(exam_id) ON DELETE CASCADE,
                student_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
                status VARCHAR(50) DEFAULT 'in_progress', -- in_progress, submitted, graded
                start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                end_time TIMESTAMP,
                submitted_at TIMESTAMP,
                disconnected_at TIMESTAMP,
                PRIMARY KEY (exam_id, student_id)
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS exam_answers (
                answer_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                exam_id UUID REFERENCES exams(exam_id) ON DELETE CASCADE,
                question_id UUID REFERENCES exam_questions(question_id) ON DELETE CASCADE,
                student_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
                selected_option_id UUID REFERENCES exam_mcq_options(option_id),
                answer_text TEXT,
                marks_obtained INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT unique_answer_per_question UNIQUE (exam_id, question_id, student_id)
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS exam_results (
                exam_id UUID REFERENCES exams(exam_id) ON DELETE CASCADE,
                student_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
                total_marks INT NOT NULL,
                obtained_marks INT NOT NULL,
                percentage FLOAT NOT NULL,
                passed BOOLEAN DEFAULT FALSE,
                evaluated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (exam_id, student_id)
            );
        `);

        console.log("   - Setting up Exam Violations...");
        await pool.query(`
            CREATE TABLE IF NOT EXISTS exam_violations (
                violation_id SERIAL PRIMARY KEY,
                exam_id TEXT NOT NULL,
                student_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
                violation_type VARCHAR(50) NOT NULL,
                details JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            ALTER TABLE exam_violations
            ALTER COLUMN exam_id TYPE TEXT USING exam_id::text;
        `).catch(() => {});

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_exam_violations_student_exam
            ON exam_violations(student_id, exam_id, created_at DESC);
        `);

        // 4. Practice Challenges
        console.log("   - Setting up Practice Challenges...");
        await pool.query(`
            CREATE TABLE IF NOT EXISTS practice_challenges (
                challenge_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                title VARCHAR(255) NOT NULL,
                description TEXT NOT NULL,
                type VARCHAR(50) DEFAULT 'code',
                difficulty VARCHAR(50) CHECK (difficulty IN ('Easy', 'Medium', 'Hard')),
                starter_code TEXT,
                test_cases JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 5. Course Comments
        console.log("   - Setting up Course Comments...");
        await pool.query(`
            CREATE TABLE IF NOT EXISTS course_comments (
                comment_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                course_id UUID REFERENCES courses(courses_id) ON DELETE CASCADE,
                user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
                comment_text TEXT NOT NULL,
                parent_comment_id UUID REFERENCES course_comments(comment_id) ON DELETE CASCADE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Legacy schema compatibility: normalize older column names if they exist
        await pool.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = 'course_comments' AND column_name = 'id'
                ) THEN
                    ALTER TABLE course_comments RENAME COLUMN id TO comment_id;
                END IF;

                IF EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = 'course_comments' AND column_name = 'text'
                ) THEN
                    ALTER TABLE course_comments RENAME COLUMN text TO comment_text;
                END IF;

                IF EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = 'course_comments' AND column_name = 'parent_id'
                ) THEN
                    ALTER TABLE course_comments RENAME COLUMN parent_id TO parent_comment_id;
                END IF;
            END $$;
        `);

        // Helpful indexes for comments reads
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_course_comments_course_created
            ON course_comments(course_id, created_at DESC);
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_course_comments_parent
            ON course_comments(parent_comment_id);
        `);

        console.log("   - Setting up Comment Votes...");
        await pool.query(`
            CREATE TABLE IF NOT EXISTS comment_votes (
                vote_id SERIAL PRIMARY KEY,
                comment_id UUID REFERENCES course_comments(comment_id) ON DELETE CASCADE,
                user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
                vote_type INTEGER NOT NULL, -- 1 for upvote, -1 for downvote
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(comment_id, user_id)
            );
        `);

        // Ensure expected vote_type semantics and fast lookups
        await pool.query(`
            ALTER TABLE comment_votes
            ADD CONSTRAINT comment_votes_vote_type_check
            CHECK (vote_type IN (-1, 1)) NOT VALID;
        `).catch(() => {});
        await pool.query(`
            ALTER TABLE comment_votes
            VALIDATE CONSTRAINT comment_votes_vote_type_check;
        `).catch(() => {});
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_comment_votes_comment
            ON comment_votes(comment_id);
        `);

        // Ensure exam_type column exists (for contests support)
        await pool.query(`
            ALTER TABLE exams ADD COLUMN IF NOT EXISTS exam_type VARCHAR(50) DEFAULT 'exam';
        `);

        // 6. Contest Tables (MCQ, Descriptive, Coding Questions)
        console.log("   - Setting up Contest Tables...");
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS contest_questions (
                question_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                exam_id UUID REFERENCES exams(exam_id) ON DELETE CASCADE,
                question_text TEXT NOT NULL,
                question_type VARCHAR(50) DEFAULT 'mcq', -- mcq, descriptive, coding
                marks INT DEFAULT 1,
                keywords JSONB, -- for descriptive question auto-grading
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS contest_options (
                option_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                question_id UUID REFERENCES contest_questions(question_id) ON DELETE CASCADE,
                option_text TEXT NOT NULL,
                is_correct BOOLEAN DEFAULT FALSE
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS contest_coding_questions (
                coding_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                question_id UUID REFERENCES contest_questions(question_id) ON DELETE CASCADE,
                title VARCHAR(255) NOT NULL,
                description TEXT,
                language VARCHAR(50),
                starter_code TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS contest_test_cases (
                test_id SERIAL PRIMARY KEY,
                coding_id UUID REFERENCES contest_coding_questions(coding_id) ON DELETE CASCADE,
                input TEXT,
                expected_output TEXT,
                is_hidden BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS contest_submissions (
                submission_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                contest_id UUID REFERENCES exams(exam_id) ON DELETE CASCADE,
                student_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
                total_marks INT DEFAULT 0,
                obtained_marks INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS contest_submission_answers (
                answer_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                submission_id UUID REFERENCES contest_submissions(submission_id) ON DELETE CASCADE,
                question_id UUID REFERENCES contest_questions(question_id) ON DELETE CASCADE,
                option_id UUID REFERENCES contest_options(option_id) ON DELETE SET NULL,
                descriptive_answer TEXT,
                marks_obtained INT DEFAULT 0,
                test_results JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Table to store test run results when student clicks "Run"
        await pool.query(`
            CREATE TABLE IF NOT EXISTS contest_test_runs (
                run_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                student_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
                question_id UUID REFERENCES contest_questions(question_id) ON DELETE CASCADE,
                code TEXT NOT NULL,
                language VARCHAR(50),
                test_results JSONB,
                marks_obtained INT DEFAULT 0,
                passed_count INT DEFAULT 0,
                total_tests INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Migrations for contest tables
        console.log("   - Migrating Contest Tables...");
        
        // Ensure test_results column exists in contest_submission_answers
        try {
            await pool.query(`
                ALTER TABLE contest_submission_answers 
                ADD COLUMN IF NOT EXISTS test_results JSONB;
            `);
            console.log("     ✓ test_results column added to contest_submission_answers");
        } catch (err) {
            console.warn("     ⚠ Could not add test_results column:", err.message);
        }

        // Create indexes for better query performance
        try {
            await pool.query(`
                CREATE INDEX IF NOT EXISTS idx_contest_test_runs_student_question
                ON contest_test_runs(student_id, question_id, created_at DESC);
            `);
            console.log("     ✓ Index created for contest_test_runs");
        } catch (err) {
            console.warn("     ⚠ Could not create index:", err.message);
        }

        try {
            await pool.query(`
                CREATE INDEX IF NOT EXISTS idx_contest_submission_answers_submission
                ON contest_submission_answers(submission_id, question_id);
            `);
            console.log("     ✓ Index created for contest_submission_answers");
        } catch (err) {
            console.warn("     ⚠ Could not create index:", err.message);
        }

        // 6. Notifications
        console.log("   - Setting up Notifications...");
        await pool.query(`
            CREATE TABLE IF NOT EXISTS notifications (
                id SERIAL PRIMARY KEY,
                user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
                message TEXT NOT NULL,
                link TEXT,
                is_read BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 7. Certificates
        console.log("   - Setting up Certificates...");
        await pool.query(`
            CREATE TABLE IF NOT EXISTS certificates (
                id SERIAL PRIMARY KEY,
                user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
                exam_id UUID REFERENCES exams(exam_id) ON DELETE CASCADE,
                exam_name VARCHAR(255),
                score INT,
                certificate_id VARCHAR(255),
                issued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, exam_id)
            );
        `);
        await pool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_certificates_certificate_id_unique
            ON certificates(certificate_id)
            WHERE certificate_id IS NOT NULL;
        `).catch(() => {});
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_certificates_issued_at
            ON certificates(issued_at);
        `).catch(() => {});

        console.log("✅ Database tables verified and initialized successfully!");
    } catch (err) {
        console.error("❌ Database Initialization Error:", err);
        // We don't exit process here to allow the app to try starting anyway,
        // but critical features might fail.
    }
};