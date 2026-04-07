import express from "express";
import { OpenAI } from "openai";
import pool from "../db/postgres.js";

const router = express.Router();

// Initialize OpenAI client with Hugging Face router
const client = new OpenAI({
  baseURL: "https://router.huggingface.co/v1",
  apiKey: process.env.HF_TOKEN,
});

// POST /api/bot/chat
// Body: { message: '...', username: '...' }
router.post("/chat", async (req, res) => {
  const HF_TOKEN = process.env.HF_TOKEN;

  if (!HF_TOKEN) {
    return res.status(500).json({
      message: "Bot API not configured on server (HF_TOKEN missing)"
    });
  }

  try {
    const { message, username } = req.body;

    if (!message) {
      return res.status(400).json({
        message: "Message is required"
      });
    }

    if (!username) {
      return res.status(400).json({
        message: "Username is required"
      });
    }

    // Look up user_id from username
    const userResult = await pool.query(
      `SELECT user_id FROM users WHERE email = $1 OR full_name = $1`,
      [username]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        message: "User not found"
      });
    }

    const userId = userResult.rows[0].user_id;

    // Call Hugging Face router with Llama-3.1-8B-Instruct model
    const chatCompletion = await client.chat.completions.create({
      model: "meta-llama/Llama-3.1-8B-Instruct:novita",
      messages: [
        {
          role: "system",
          content: "You are a helpful educational assistant for students in a Learning Management System. Provide BRIEF answers in 2-4 lines only. Be clear, concise, and accurate. Do not exceed 4 lines in your response."
        },
        {
          role:
            "user",
          content: message,
        },
      ],
      max_tokens: 50,
      temperature: 0.7,
    });

    // Extract the assistant's response
    const reply = chatCompletion.choices[0].message.content;

    // Save conversation to database
    await pool.query(
      `INSERT INTO chat_messages (user_id, user_message, bot_response, model_used)
       VALUES ($1, $2, $3, $4)`,
      [userId, message, reply, "meta-llama/Llama-3.1-8B-Instruct:novita"]
    );

    return res.status(200).json({
      reply,
      model: "meta-llama/Llama-3.1-8B-Instruct:novita"
    });
  } catch (err) {
    console.error("Error calling Hugging Face:", err?.message);
    const status = err?.status || 500;
    const errorMessage = err?.message || "Failed to contact bot provider";
    return res.status(status).json({
      message: errorMessage,
      error: err?.error?.message || errorMessage
    });
  }
});

// GET /api/bot/history/:username
// Fetch chat history for a specific username
router.get("/history/:username", async (req, res) => {
  try {
    const { username } = req.params;

    // Look up user_id from username
    const userResult = await pool.query(
      `SELECT user_id FROM users WHERE email = $1 OR full_name = $1`,
      [username]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        message: "User not found"
      });
    }

    const userId = userResult.rows[0].user_id;

    const result = await pool.query(
      `SELECT message_id, user_message, bot_response, model_used, created_at
       FROM chat_messages
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [userId]
    );

    return res.status(200).json({
      history: result.rows
    });
  } catch (err) {
    console.error("Error fetching chat history:", err?.message);
    return res.status(500).json({
      message: "Failed to fetch chat history"
    });
  }
});

export default router;