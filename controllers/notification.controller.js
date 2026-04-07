import pool from "../db/postgres.js";

// Get user's notifications
export const getMyNotifications = async (req, res) => {
    try {
        // Support both `user_id` and `id` properties on req.user
        const userId = req.user?.user_id || req.user?.id;

        if (!userId) {
            return res.json([]);
        }

        // Streak-expiring notification when user inactive for 3+ days
        try {
            const userMeta = await pool.query(
                `SELECT last_active_date, streak FROM users WHERE user_id = $1`,
                [userId]
            );

            if (userMeta.rows.length > 0) {
                const { last_active_date: lastActive } = userMeta.rows[0];
                if (lastActive) {
                    const lastActiveDate = new Date(lastActive);
                    const now = new Date();
                    const diffMs = now.setHours(0, 0, 0, 0) - lastActiveDate.setHours(0, 0, 0, 0);
                    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

                    if (diffDays >= 3) {
                        const message = "Your streak is expiring. Come back today to keep it alive!";
                        await pool.query(
                            `INSERT INTO notifications (user_id, message, link)
                             SELECT $1, $2, $3
                             WHERE NOT EXISTS (
                               SELECT 1 FROM notifications
                               WHERE user_id = $1
                                 AND message = $2
                                 AND created_at::date = CURRENT_DATE
                             )`,
                            [userId, message, "/student/dashboard"]
                        );
                    }
                }
            }
        } catch (metaErr) {
            console.error("Streak notification error:", metaErr);
        }

        const result = await pool.query(
            `SELECT * FROM notifications 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT 20`,
            [userId]
        );

        res.json(result.rows);
    } catch (error) {
        console.error("Get notifications error:", error);
        res.status(500).json({ message: "Failed to fetch notifications" });
    }
};

// Mark as read
export const markAsRead = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user?.user_id || req.user?.id;

        if (!userId) {
            return res.status(400).json({ message: "Invalid user" });
        }

        await pool.query(
            `UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2`,
            [id, userId]
        );

        res.json({ message: "Marked as read" });
    } catch (error) {
        console.error("Mark read error:", error);
        res.status(500).json({ message: "Failed to update notification" });
    }
}

// Save push subscription
export const subscribe = async (req, res) => {
    const { subscription } = req.body;
    // Support both `user_id` and `id` properties on req.user
    const userId = req.user?.user_id || req.user?.id;

    if (!subscription || !subscription.endpoint || !subscription.keys) {
        return res.status(400).json({ message: "Invalid subscription object" });
    }

    try {
        await pool.query(
            `INSERT INTO push_subscriptions (user_id, endpoint, keys)
             VALUES ($1, $2, $3)
             ON CONFLICT (endpoint) DO UPDATE SET keys = $3, updated_at = NOW()`,
            [userId, subscription.endpoint, subscription.keys]
        );

        res.status(201).json({ message: "Subscription saved successfully" });
    } catch (err) {
        console.error("Save subscription error:", err);
        res.status(500).json({ message: "Failed to save subscription" });
    }
};
