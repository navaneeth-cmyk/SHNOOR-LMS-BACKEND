import pool from "../db/postgres.js";
const attachUser = async (req, res, next) => {
  try {
    if (!req.firebase || !req.firebase.uid) {
      return res.status(401).json({
        message: "Unauthorized (Firebase identity missing)",
      });
    }

    const firebaseUid = req.firebase.uid;

    const result = await pool.query(
      `SELECT
         user_id,
         full_name,
         email,
         role,
         status
       FROM users
       WHERE firebase_uid = $1`,
      [firebaseUid],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "User not found in system",
      });
    }

    const user = result.rows[0];
    if (user.status !== "active") {
      return res.status(403).json({
        message: "Your account is suspended or inactive. Contact admin.",
      });
    }
    req.user = {
      id: user.user_id,
      fullName: user.full_name,
      email: user.email,
      role: user.role,
      status: user.status,
    };
    next();
  } catch (error) {
    console.error("attachUser error:", error);
    res.status(500).json({
      message: "Server error",
    });
  }
};
export default attachUser;
