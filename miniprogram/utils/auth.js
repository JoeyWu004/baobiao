// utils/auth.js 登录态（简化版：过期时弹出登录提示）
const SESSION_DAYS = 7; // 登录有效期

function getSession() {
  return wx.getStorageSync("userInfo") || null;
}

// 登录态是否有效
function isSessionValid() {
  const u = getSession();
  if (!u || !u.openid) return false;
  if (!u.expiresAt) return true; // 兼容旧数据：视为有效
  return Date.now() < u.expiresAt;
}

// 保存登录态（带过期时间）
function saveSession(userInfo) {
  const data = Object.assign({}, userInfo, {
    expiresAt: Date.now() + SESSION_DAYS * 24 * 3600 * 1000,
  });
  wx.setStorageSync("userInfo", data);
  const app = getApp();
  if (app && app.globalData) app.globalData.userInfo = data;
  return data;
}

// 清除登录态
function clearSession() {
  wx.removeStorageSync("userInfo");
  const app = getApp();
  if (app && app.globalData) {
    app.globalData.userInfo = null;
    app.globalData.loginPrompted = false;
  }
}

// 登录态无效时弹出提示（每次启动只提示一次）
function ensureLogin() {
  if (isSessionValid()) return true;
  const app = getApp();
  if (app.globalData && !app.globalData.loginPrompted) {
    app.globalData.loginPrompted = true;
    wx.showModal({
      title: "需要登录",
      content: "登录状态已过期，请重新登录后再使用。",
      confirmText: "去登录",
      cancelText: "暂不",
      success: (res) => {
        if (res.confirm) {
          wx.navigateTo({ url: "/pages/login/login" });
        }
      },
    });
  }
  return false;
}

module.exports = {
  getSession,
  isSessionValid,
  saveSession,
  clearSession,
  ensureLogin,
};
