{/*const roleGuard = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        message: "Unauthorized (user not loaded)",
      });
    }

    const { role, status } = req.user;

    if (status !== "active") {
      return res.status(403).json({
        message: "Account is not active",
      });
    }

    if (!allowedRoles.includes(role)) {
      return res.status(403).json({
        message: "Access denied",
      });
    }

    next();
  };
};

export default roleGuard;*/}


const roleGuard = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        message: "Unauthorized (user not loaded)",
      });
    }

    const { role } = req.user;

    if (allowedRoles.length === 0) {
      return next();
    }

    // 🔐 Role-based access only
    if (!allowedRoles.includes(role)) {
      return res.status(403).json({
        message: "Access denied",
      });
    }

    next();
  };
};

export default roleGuard;
