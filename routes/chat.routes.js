import express from "express";
import multer from "multer";

import {
    getMyChats,
    getMessages,
    createChat,
    markRead,
    uploadFile,
    getAvailableStudents,
    getAvailableInstructors,
    createGroup,
    getMyGroups,
    getAvailableGroups,
    joinGroup,
    updateMeetingLink,
    stopMeeting,
    getGroupMessages,
    editMessage,
    deleteMessage,
    getGroupMembers,
    updateGroup,
    leaveGroup,
    deleteGroup,
    promoteToAdmin,
    removeMember,
    addReaction,
    removeReaction,
    serveFile,
    searchMessages,
    searchContacts
} from "../controllers/chat.controller.js";
import firebaseAuth from "../middlewares/firebaseAuth.js";
import attachUser from "../middlewares/attachUser.js";
const router = express.Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

router.get("/search-contacts", firebaseAuth, attachUser, searchContacts);
router.get("/media/:id", serveFile);
router.get("/", firebaseAuth, attachUser, getMyChats);
router.get("/messages/:chatId", firebaseAuth, attachUser, getMessages);
router.put("/messages/:messageId", firebaseAuth, attachUser, editMessage);
router.delete("/messages/:messageId", firebaseAuth, attachUser, deleteMessage);
router.get("/available-students", firebaseAuth, attachUser, getAvailableStudents);
router.get("/available-instructors", firebaseAuth, attachUser, getAvailableInstructors);
router.post("/", firebaseAuth, attachUser, createChat);
router.post("/upload", firebaseAuth, attachUser, upload.single('file'), uploadFile);
router.put("/read", firebaseAuth, attachUser, markRead);
router.get("/search", firebaseAuth, attachUser, searchMessages);

// Groups
router.post("/groups", firebaseAuth, attachUser, createGroup);
router.get("/groups/my", firebaseAuth, attachUser, getMyGroups);
router.get("/groups/available", firebaseAuth, attachUser, getAvailableGroups);
router.post("/groups/:groupId/join", firebaseAuth, attachUser, joinGroup);
router.put("/groups/:groupId/meeting", firebaseAuth, attachUser, updateMeetingLink);
router.delete("/groups/:groupId/meeting", firebaseAuth, attachUser, stopMeeting);
router.get("/groups/:groupId/messages", firebaseAuth, attachUser, getGroupMessages);
router.get("/groups/:groupId/members", firebaseAuth, attachUser, getGroupMembers);
router.put("/groups/:groupId", firebaseAuth, attachUser, updateGroup);
router.post("/groups/:groupId/leave", firebaseAuth, attachUser, leaveGroup);
router.delete("/groups/:groupId", firebaseAuth, attachUser, deleteGroup);
router.put("/groups/:groupId/promote/:userId", firebaseAuth, attachUser, promoteToAdmin);
router.delete("/groups/:groupId/members/:userId", firebaseAuth, attachUser, removeMember);

// Reactions
router.post("/messages/:messageId/react", firebaseAuth, attachUser, addReaction);
router.delete("/messages/:messageId/react", firebaseAuth, attachUser, removeReaction);

console.log("✅ Chat routes registered");

export default router;