const db = require('../config/db')

/* --------------------------------------------------
   GET WORK ORDER ITEMS BY WORK ORDER ID
-------------------------------------------------- */
const getWorkOrderItemById = async (req, res) => {
  try {
    const { id } = req.params

    const [rows] = await db.query(
      `SELECT * FROM WorkOrderItems WHERE WorkOrderID = ?`,
      [id]
    )

    if (!rows.length) {
      return res.status(404).json({
        message: 'WorkOrderItem not found'
      })
    }

    return res.status(200).json(rows)

  } catch (err) {
    console.error('Error fetching WorkOrderItem:', err)
    return res.status(500).json({
      error: 'Error fetching WorkOrderItem.',
      details: err.message
    })
  }
}

/* --------------------------------------------------
   CREATE WORK ORDER ITEM
-------------------------------------------------- */
const createWorkOrderItem = async (req, res) => {
  try {
    const {
      WorkOrderID,
      ProductName,
      MakingSize,
      Number,
      Weight,
      TotalRft,
      TotalSqft,
      SlittingSize,
      Thickness
    } = req.body

    /* ✅ Strict validation */
    if (
      !WorkOrderID ||
      !ProductName ||
      !MakingSize ||
      Number == null ||
      Weight == null ||
      TotalRft == null ||
      TotalSqft == null ||
      !SlittingSize ||
      !Thickness
    ) {
      return res.status(400).json({
        error: 'All fields are required.'
      })
    }

    const [result] = await db.query(
      `
      INSERT INTO WorkOrderItems
      (WorkOrderID, ProductName, MakingSize, Number, Weight, TotalRft, TotalSqft, SlittingSize, Thickness)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        WorkOrderID,
        ProductName,
        MakingSize,
        Number,
        Weight,
        TotalRft,
        TotalSqft,
        SlittingSize,
        Thickness
      ]
    )

    return res.status(201).json({
      message: 'Work order item saved successfully.',
      workOrderItemID: result.insertId
    })

  } catch (err) {
    console.error('Error saving WorkOrderItem:', err)
    return res.status(500).json({
      error: 'Error saving WorkOrderItem.',
      details: err.message
    })
  }
}

module.exports = {
  getWorkOrderItemById,
  createWorkOrderItem
}
