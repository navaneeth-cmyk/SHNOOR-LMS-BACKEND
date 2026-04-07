import admin from "../services/firebaseAdmin.js";
const firebaseAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    let token;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.split(" ")[1];
    } else if (req.query.token) {
      token = req.query.token;
    }

    if (!token) {
      return res
        .status(401)
        .json({ message: "Authorization token missing or invalid" });
    }

    const decodedToken = await admin.auth().verifyIdToken(token);
    req.firebase = {
      uid: decodedToken.uid,
      email: decodedToken.email,
      name: decodedToken.name || decodedToken.email,
    };

    next();
  } catch (error) {
    console.error("❌ Firebase auth error:", error.message);
    res.status(401).json({ message: "Invalid or expired token" });
  }
};

export default firebaseAuth;