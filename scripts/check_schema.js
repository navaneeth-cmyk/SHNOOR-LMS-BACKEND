import pool from "../db/postgres.js";

async function checkSchema() {
    try {
        const res = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'exams'");
        console.log(JSON.stringify(res.rows.map(r => r.column_name), null, 2));
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

checkSchema();