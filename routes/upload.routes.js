import express from "express";
import { uploadFile, handleUpload } from "../controllers/upload.controller.js";
import firebaseAuth from "../middlewares/firebaseAuth.js";
import attachUser from "../middlewares/attachUser.js";
import roleGuard from "../middlewares/roleGuard.js";

const router = express.Router();

router.post(
    "/",
    firebaseAuth,
    attachUser,
    roleGuard("instructor", "admin"), // Only instructors/admins can upload
    (req, res, next) => {
        uploadFile(req, res, (err) => {
            if (err) {
                return res.status(400).json({ message: err.message });
            }
            next();
        });
    },
    handleUpload
);

export default router;
