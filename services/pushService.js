import webpush from "web-push";
import pool from "../db/postgres.js";

// VAPID keys should be in .env
const publicVapidKey = process.env.VAPID_PUBLIC_KEY;
const privateVapidKey = process.env.VAPID_PRIVATE_KEY;

if (!publicVapidKey || !privateVapidKey) {
    console.warn("⚠️ Web Push VAPID keys are missing in .env");
} else {
    webpush.setVapidDetails(
        process.env.VAPID_SUBJECT || "mailto:admin@example.com",
        publicVapidKey,
        privateVapidKey
    );
}

export const sendPushNotification = async (userId, payload) => {
    try {
        // 1. Fetch subscriptions for the user
        // We fetch ALL valid subscriptions (a user might have multiple devices)
        const result = await pool.query(
            `SELECT endpoint, keys FROM push_subscriptions WHERE user_id = $1`,
            [userId]
        );

        const subscriptions = result.rows;

        if (subscriptions.length === 0) {
            console.log(`ℹ️ No push subscriptions found for user ${userId}`);
            return;
        }

        console.log(`🚀 Sending push notification to ${subscriptions.length} devices for user ${userId}`);

        // 2. Send notification to all subscriptions
        const notificationPayload = JSON.stringify(payload);

        const promises = subscriptions.map(async (sub) => {
            const pushSubscription = {
                endpoint: sub.endpoint,
                keys: sub.keys,
            };

            try {
                await webpush.sendNotification(pushSubscription, notificationPayload);
            } catch (error) {
                // Check for 410 Gone or 404 Not Found (expired subscription)
                if (error.statusCode === 410 || error.statusCode === 404) {
                    console.log(`🗑️ Removing expired subscription: ${sub.endpoint}`);
                    await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [sub.endpoint]);
                } else {
                    console.error("❌ Error sending push:", error.message);
                }
            }
        });

        await Promise.all(promises);

    } catch (err) {
        console.error("❌ sendPushNotification error:", err);
    }
};
