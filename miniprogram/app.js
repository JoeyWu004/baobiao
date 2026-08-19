// app.js
const { getSession, isSessionValid } = require("./utils/auth");
const recognition = require("./utils/recognition");

App({
  onLaunch: function () {
    // env 参数说明：
    // env 参数决定小程序发起的云开发调用（wx.cloud.xxx）请求到哪个云环境
    // 在微信开发者工具中点击「云开发」按钮开通环境后，把环境 ID 填到下面
    // 例：env: "report-xxxxxx"
    this.globalData = {
      env: "cloud1-3gkkuigx6175193d",
      userInfo: null, // { openid, nickname, avatar }
      loginPrompted: false, // 本次启动是否已弹过登录提示
      reportSort: { key: "date", order: "desc" }, // 报表页排序（本次生命周期内保持）
    };
    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
    } else {
      wx.cloud.init({
        env: this.globalData.env,
        traceUser: true,
      });
    }
    // 读取登录态（过期则视为未登录）
    if (isSessionValid()) {
      this.globalData.userInfo = getSession();
    }
    // 续跑后台发票识别（小程序被杀/切后台后恢复）
    recognition.resume();
  },
  onShow: function () {
    // 回前台时若有未完成的识别任务则继续跑
    recognition.resume();
  },
});
