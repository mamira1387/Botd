// index.js (در ریشه پروژه)
module.exports = (req, res) => {
  res.status(200).json({ 
    status: "online", 
    message: "Depth TON Bot is running!", 
    version: "1.0.0" 
  });
};
