import multer from "multer";

const storage = multer.memoryStorage(); // Store in memory for immediate parsing

const fileFilter = (req, file, cb) => {
    if (file.mimetype === "text/csv" || file.mimetype === "application/vnd.ms-excel" || file.originalname.endsWith(".csv")) {
        cb(null, true);
    } else {
        cb(new Error("Only .csv files are allowed!"), false);
    }
};

const uploadCsv = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
});

export default uploadCsv;