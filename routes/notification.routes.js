import express from "express";
import firebaseAuth from "../middlewares/firebaseAuth.js";
import attachUser from "../middlewares/attachUser.js";
import { getMyNotifications, markAsRead, subscribe } from "../controllers/notification.controller.js";

const router = express.Router();

router.use(firebaseAuth);
router.use(attachUser);

router.get("/", getMyNotifications);
router.put("/:id/read", markAsRead);
router.post("/subscribe", subscribe);

export default router;
