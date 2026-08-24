import express from 'express';
import * as db from '../../database.js';
import {
  authenticateJWT,
  authorizeRoles
} from './authMiddleware.js';

const router = express.Router();

// Owner dan Admin bisa melihat daftar customer
router.get('/customers', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const customers = await db.getCustomersWithTiers();
    res.json({ success: true, customers });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Owner dan Admin bisa melihat detail customer
router.get('/customers/:nomor', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const details = await db.getCustomerDetails(req.params.nomor);
    if (!details) {
      return res.status(404).json({ success: false, message: "Customer tidak ditemukan." });
    }
    res.json({ success: true, customer: details });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.patch('/customers/:nomor/role', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const profile = await db.updateCustomerRole(req.params.nomor, req.body.role);
    res.json({ success: true, customer: profile });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.patch('/customers/:nomor/status', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const profile = await db.updateCustomerAccountStatus(req.params.nomor, req.body.status);
    res.json({ success: true, customer: profile });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

export default router;
