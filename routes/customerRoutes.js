const express = require("express");
const customerController = require("../controllers/customerController");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

// All routes require authentication
router.use(authMiddleware);

// Create new customer
router.post("/", customerController.createCustomer);

// Get all customers
router.get("/", customerController.getAllCustomers);

// Get customer by ID
router.get("/:id", customerController.getCustomerById);

// Update customer
router.put("/:id", customerController.updateCustomer);

// Delete customer
router.delete("/:id", customerController.deleteCustomer);

module.exports = router;
