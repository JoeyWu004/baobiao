// pages/login/login.js 微信登录（一键）
const { saveSession } = require("../../utils/auth");

Page({
  data: {
    logging: false,
    // 首次登录引导：头像（临时文件）+ 昵称
    avatarUrl: "",
    avatarTemp: "",
    nickname: "",
  },

  // 选择微信头像：open-type=chooseAvatar 返回临时文件路径
  onChooseAvatar(e) {
    const tempPath = e.detail.avatarUrl;
    if (tempPath) this.setData({ avatarUrl: tempPath, avatarTemp: tempPath });
  },

  onNickInput(e) {
    this.setData({ nickname: e.detail.value });
  },

  async onLogin() {
    if (this.data.logging) return;
    this.setData({ logging: true });
    wx.showLoading({ title: "登录中…", mask: true });
    try {
      // 如果选了新头像，先上传云存储拿 fileID
      let avatarFileID = "";
      if (this.data.avatarTemp) {
        const m = /\.(\w+)$/.exec(this.data.avatarTemp);
        const ext = m ? m[1] : "png";
        const cloudPath = `avatars/${Date.now()}-${Math.floor(Math.random() * 100000)}.${ext}`;
        const up = await wx.cloud.uploadFile({
          cloudPath,
          filePath: this.data.avatarTemp,
        });
        avatarFileID = up.fileID;
      }
      const nickname = (this.data.nickname || "").trim() || "微信用户";
      const res = await wx.cloud.callFunction({
        name: "userOps",
        data: { action: "login", nickname, avatar: avatarFileID },
      });
      wx.hideLoading();
      if (res.result && res.result.success) {
        const u = res.result.user;
        saveSession({
          openid: u.openid,
          nickname: u.nickname || nickname,
          avatar: u.avatar || "",
        });
        wx.reLaunch({ url: "/pages/report-list/report-list" });
      } else {
        this.setData({ logging: false });
        wx.showToast({ title: (res.result && res.result.msg) || "登录失败", icon: "none" });
      }
    } catch (e) {
      wx.hideLoading();
      this.setData({ logging: false });
      console.error("登录失败", e);
      wx.showModal({
        title: "登录失败",
        content: "请确认已配置云环境 ID，且 userOps 云函数已部署。",
        showCancel: false,
      });
    }
  },
});
