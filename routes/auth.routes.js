import express from "express";
import {
  register,
  login,
  logout,
  getMe
} from "../controllers/auth.controller.js";

import firebaseAuth from "../middlewares/firebaseAuth.js";
import attachUser from "../middlewares/attachUser.js";

const router = express.Router();


router.post("/register", register);


router.post(
  "/login",
  firebaseAuth,   // 🔑 VERIFY TOKEN HERE
  login           // ✅ USE req.firebase
);


router.post(
  "/logout",
  firebaseAuth,
  attachUser,
  logout
);

router.get(
  "/me",
  firebaseAuth,
  attachUser,
  getMe
);


export default router;
