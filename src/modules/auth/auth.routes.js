const express = require("express");
const router = express.Router();
const { authenticate } = require("../../middleware/auth.middleware");
const {
  registerHandler,
  loginHandler,
  refreshHandler,
  logoutHandler,
  meHandler,
  updateProfileHandler,
  changePasswordHandler,
} = require("./auth.controller");
router.post("/register", registerHandler);
router.post("/login", loginHandler);
router.post("/refresh", refreshHandler);
router.post("/logout", logoutHandler);
router.get("/me", authenticate, meHandler);
router.patch("/me", authenticate, updateProfileHandler);
router.post("/change-password", authenticate, changePasswordHandler);

module.exports = router;
