export const getEmbedUrl = (url) => {
    if (!url) return "";

    // Already an embed URL
    if (url.includes("/embed/")) return url;

    // YouTube handling
    if (url.includes("youtube.com") || url.includes("youtu.be")) {
        let videoId = "";
        if (url.includes("v=")) {
            videoId = url.split("v=")[1].split("&")[0];
        }
        else if (url.includes("youtu.be/")) {
            videoId = url.split("youtu.be/")[1].split("?")[0];
        }
        else if (url.includes("/shorts/")) {
            videoId = url.split("/shorts/")[1].split("?")[0];
        }
        else {
            const parts = url.split("/");
            const lastPart = parts[parts.length - 1];
            if (lastPart && lastPart.length > 5) {
                videoId = lastPart;
            }
        }

        if (videoId) {
            return `https://www.youtube-nocookie.com/embed/${videoId}`;
        }
    }

    // Gamma handling
    if (url.includes("gamma.app")) {
        // Handle gamma.app/public/ID or gamma.app/docs/ID
        return url.replace("gamma.app/public/", "gamma.app/embed/")
            .replace("gamma.app/docs/", "gamma.app/embed/");
    }

    return url;
};