import 'dotenv/config'; // Top-level for correct process.env
import pool from './postgres.js';

const fixCommentsSchema = async () => {
    try {
        console.log('Starting Comments Schema Fix...');

        // 1. Rename columns in course_comments to match controller
        console.log('Renaming course_comments columns...');
        
        // id -> comment_id
        const idCheck = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'course_comments' AND column_name = 'id'");
        if (idCheck.rows.length > 0) {
            await pool.query('ALTER TABLE course_comments RENAME COLUMN id TO comment_id');
            console.log('✅ id -> comment_id');
        }

        // text -> comment_text
        const textCheck = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'course_comments' AND column_name = 'text'");
        if (textCheck.rows.length > 0) {
            await pool.query('ALTER TABLE course_comments RENAME COLUMN text TO comment_text');
            console.log('✅ text -> comment_text');
        }

        // parent_id -> parent_comment_id
        const parentCheck = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'course_comments' AND column_name = 'parent_id'");
        if (parentCheck.rows.length > 0) {
            await pool.query('ALTER TABLE course_comments RENAME COLUMN parent_id TO parent_comment_id');
            console.log('✅ parent_id -> parent_comment_id');
        }

        // 2. Fix comment_votes vote_type to match controller (INT)
        console.log('Fixing comment_votes.vote_type to INTEGER (if needed)...');
        const voteTypeCheck = await pool.query("SELECT data_type FROM information_schema.columns WHERE table_name = 'comment_votes' AND column_name = 'vote_type'");
        
        if (voteTypeCheck.rows.length > 0 && voteTypeCheck.rows[0].data_type === 'character varying') {
            await pool.query('ALTER TABLE comment_votes ALTER COLUMN vote_type TYPE INTEGER USING (CASE WHEN vote_type = \'upvote\' THEN 1 WHEN vote_type = \'downvote\' THEN -1 ELSE 0 END)');
            console.log('✅ vote_type changed to INTEGER');
        }

        console.log('Comments Schema Fix completed successfully.');
    } catch (error) {
        console.error('Comments Schema Fix failed:', error);
    } finally {
        pool.end();
    }
};

fixCommentsSchema();