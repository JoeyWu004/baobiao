// pages/profile/profile.js 我的：当前用户 + 回收站 + 服务说明 + 识别设置 + 退出登录
const { getSession, isSessionValid, saveSession, clearSession } = require("../../utils/auth");
const { callUserOps } = require("../../utils/cloud");
const { modelLabel: modelLabelOf } = require("../../utils/modelLabel");

// 发票识别可选模型（与 userOps / invoiceOCR 的 ALLOWED_MODELS 保持一致）
const KIMI_MODELS = [
  {
    value: "kimi-k2.6",
    label: "Kimi K2.6",
  },
  {
    value: "kimi-k3",
    label: "Kimi K3",
  },
  {
    value: "deepseek-flash",
    label: "DeepSeek V4.1 Flash",
  },
];

Page({
  data: {
    userInfo: null,
    avatarUrl: "",
    // 编辑资料（头像 / 昵称，同步微信）
    showProfileModal: false,
    editNickname: "",
    editAvatarUrl: "",
    editAvatarTemp: "",
    serviceNote: "",
    // 识别设置（识别模型 + 各服务商 Key / 地址，二合一）
    kimiApiKey: "",
    kimiMasked: "",
    kimiModel: "",
    kimiModelLabel: "",
    // 当前所选模型的 key 遮蔽串（识别设置入口副标题）
    recMasked: "",
    // DeepSeek：只存 Key（地址固定用官方默认，可被 invoiceOCR 环境变量覆盖）
    deepseekApiKey: "",
    deepseekMasked: "",
    // 当前是否为 DeepSeek 模型（决定弹窗显示哪些输入框）
    isDeepSeekModel: false,
    // 服务说明编辑弹窗
    showNoteModal: false,
    noteValue: "",
    // 识别设置弹窗（一个弹窗内包含模型选择 + Key 输入）
    showRecModal: false,
    kimiValue: "",
    deepseekValue: "",
    saving: false,
  },

  onShow() {
    this.loadUser();
  },

  loadUser() {
    const userInfo = isSessionValid() ? getSession() : null;
    this.setData({ userInfo });
    if (userInfo && userInfo.avatar) {
      wx.cloud
        .getTempFileURL({ fileList: [userInfo.avatar] })
        .then((res) => {
          const f = res.fileList && res.fileList[0];
          if (f && f.tempFileURL) this.setData({ avatarUrl: f.tempFileURL });
        })
        .catch(() => {});
    } else {
      this.setData({ avatarUrl: "" });
    }
    // 获取账户服务说明 + 识别设置（Key / 模型）
    callUserOps("getUser")
      .then((res) => {
        if (res.result && res.result.success && res.result.user) {
          const u = res.result.user;
          const model = u.kimiModel || KIMI_MODELS[0].value;
          const ds = this.isDeepSeek(model);
          const keyMasked = ds
            ? u.deepseekApiKey
              ? "••••" + u.deepseekApiKey.slice(-4)
              : ""
            : u.kimiApiKey
            ? "••••" + u.kimiApiKey.slice(-4)
            : "";
          this.setData({
            serviceNote: u.serviceNote || "",
            kimiApiKey: u.kimiApiKey || "",
            kimiMasked: u.kimiApiKey ? "••••" + u.kimiApiKey.slice(-4) : "",
            kimiModel: model,
            kimiModelLabel: this.modelLabel(model),
            recMasked: keyMasked,
            isDeepSeekModel: ds,
            deepseekApiKey: u.deepseekApiKey || "",
            deepseekMasked: u.deepseekApiKey ? "••••" + u.deepseekApiKey.slice(-4) : "",
          });
        }
      })
      .catch(() => {});
  },

  // ---------- 编辑资料（头像 / 昵称，与微信保持一致） ----------
  openProfileModal() {
    this.setData({
      showProfileModal: true,
      editNickname: (this.data.userInfo && this.data.userInfo.nickname) || "",
      editAvatarUrl: this.data.avatarUrl || "",
      editAvatarTemp: "",
    });
  },

  closeProfileModal() {
    this.setData({ showProfileModal: false });
  },

  // 选择微信头像：open-type=chooseAvatar 返回临时文件路径
  onChooseAvatar(e) {
    const tempPath = e.detail.avatarUrl;
    if (tempPath) this.setData({ editAvatarUrl: tempPath, editAvatarTemp: tempPath });
  },

  onNickInput(e) {
    this.setData({ editNickname: e.detail.value });
  },

  async saveProfile() {
    if (this.data.saving) return;
    this.setData({ saving: true });
    try {
      let avatarFileID = (this.data.userInfo && this.data.userInfo.avatar) || "";
      // 用户选了新头像（临时文件）→ 先上传云存储，库里存 fileID
      if (this.data.editAvatarTemp) {
        wx.showLoading({ title: "保存中…", mask: true });
        const m = /\.(\w+)$/.exec(this.data.editAvatarTemp);
        const ext = m ? m[1] : "png";
        const cloudPath = `avatars/${Date.now()}-${Math.floor(Math.random() * 100000)}.${ext}`;
        const up = await wx.cloud.uploadFile({
          cloudPath,
          filePath: this.data.editAvatarTemp,
        });
        avatarFileID = up.fileID;
        wx.hideLoading();
      }
      const nickname = (this.data.editNickname || "").trim() || "微信用户";
      const res = await callUserOps("updateProfile", { nickname, avatar: avatarFileID });
      if (res.result && res.result.success) {
        const u = res.result.user;
        const cur = getSession() || {};
        saveSession(
          Object.assign({}, cur, {
            openid: u.openid || cur.openid,
            nickname: u.nickname || nickname,
            avatar: u.avatar || "",
          })
        );
        this.setData({ showProfileModal: false });
        this.loadUser();
        wx.showToast({ title: "已保存" });
      } else {
        wx.showToast({ title: (res.result && res.result.msg) || "保存失败", icon: "none" });
      }
    } catch (e) {
      wx.hideLoading();
      console.error("保存资料失败", e);
      wx.showToast({ title: "保存失败", icon: "none" });
    } finally {
      this.setData({ saving: false });
    }
  },

  // ---------- 识别设置（Kimi API Key + 识别模型，二合一） ----------
  isDeepSeek(value) {
    return /^deepseek/i.test(String(value || ""));
  },

  modelLabel(value) {
    const m = KIMI_MODELS.find((x) => x.value === value);
    // 不在选择列表里的值（例如 DeepSeek 改名前的旧 id）交给共用映射，
    // 认不出来就原样显示 id —— 原来兜底成列表第一项，会把别的模型显示成「Kimi K2.6」
    return m ? m.label : modelLabelOf(value);
  },

  openRecSettings() {
    this.setData({
      showRecModal: true,
      kimiValue: this.data.kimiApiKey,
      deepseekValue: this.data.deepseekApiKey,
      isDeepSeekModel: this.isDeepSeek(this.data.kimiModel),
    });
  },

  closeRecModal() {
    this.setData({ showRecModal: false });
  },

  // 弹窗内选模型：先改本地显示，点「保存」时一起落库
  onSelectModel() {
    wx.showActionSheet({
      itemList: KIMI_MODELS.map((m) => m.label),
      success: (res) => {
        const m = KIMI_MODELS[res.tapIndex];
        if (m) {
          this.setData({
            kimiModel: m.value,
            kimiModelLabel: m.label,
            isDeepSeekModel: this.isDeepSeek(m.value),
          });
        }
      },
      fail: () => {},
    });
  },

  onKimiInput(e) {
    this.setData({ kimiValue: e.detail.value });
  },

  onDeepSeekKeyInput(e) {
    this.setData({ deepseekValue: e.detail.value });
  },

  // 保存识别设置：模型 + 所选服务商的 Key / 地址一次保存
  async saveRecSettings() {
    if (this.data.saving) return;
    this.setData({ saving: true });
    try {
      const keyRes = await callUserOps("updateKimiKey", {
        kimiApiKey: this.data.kimiValue,
      });
      if (!(keyRes.result && keyRes.result.success)) {
        this.setData({ saving: false });
        wx.showToast({ title: (keyRes.result && keyRes.result.msg) || "Key 保存失败", icon: "none" });
        return;
      }
      const modelRes = await callUserOps("updateKimiModel", {
        kimiModel: this.data.kimiModel,
      });
      if (!(modelRes.result && modelRes.result.success)) {
        this.setData({ saving: false });
        wx.showToast({ title: (modelRes.result && modelRes.result.msg) || "模型保存失败", icon: "none" });
        return;
      }
      // 当前选的是 DeepSeek 时，把它的 Key / 地址也存下（切回 Kimi 时不影响）
      if (this.data.isDeepSeekModel) {
        const dsKey = await callUserOps("updateDeepSeekKey", {
          deepseekApiKey: this.data.deepseekValue,
        });
        if (!(dsKey.result && dsKey.result.success)) {
          this.setData({ saving: false });
          wx.showToast({ title: (dsKey.result && dsKey.result.msg) || "DeepSeek Key 保存失败", icon: "none" });
          return;
        }
      }
      const key = (keyRes.result.user && keyRes.result.user.kimiApiKey) || "";
      this.setData({
        kimiApiKey: key,
        kimiMasked: key ? "••••" + key.slice(-4) : "",
        showRecModal: false,
      });
      this.loadUser();
      wx.showToast({ title: "已保存" });
    } catch (e) {
      console.error("保存识别设置失败", e);
      wx.showToast({ title: "保存失败", icon: "none" });
    } finally {
      this.setData({ saving: false });
    }
  },

  noop() {},

  goTrash() {
    wx.navigateTo({ url: "/pages/trash/trash" });
  },

  goPurchases() {
    wx.navigateTo({ url: "/pages/purchases/purchases" });
  },

  // ---------- 服务说明 ----------
  openNoteModal() {
    this.setData({ showNoteModal: true, noteValue: this.data.serviceNote });
  },

  closeNoteModal() {
    this.setData({ showNoteModal: false });
  },

  onNoteInput(e) {
    this.setData({ noteValue: e.detail.value });
  },

  async saveNote() {
    if (this.data.saving) return;
    this.setData({ saving: true });
    try {
      const res = await callUserOps("updateServiceNote", {
        serviceNote: this.data.noteValue,
      });
      if (res.result && res.result.success) {
        this.setData({
          serviceNote: (res.result.user && res.result.user.serviceNote) || "",
          showNoteModal: false,
        });
        wx.showToast({ title: "已保存" });
      } else {
        wx.showToast({ title: (res.result && res.result.msg) || "保存失败", icon: "none" });
      }
    } catch (e) {
      console.error("保存服务说明失败", e);
      wx.showToast({ title: "保存失败", icon: "none" });
    } finally {
      this.setData({ saving: false });
    }
  },

  noop() {},

  onLogout() {
    wx.showModal({
      title: "退出登录",
      content: "退出后将切换账号，数据按各自账号隔离保存。",
      confirmColor: "#fa5151",
      success: (res) => {
        if (!res.confirm) return;
        clearSession();
        wx.reLaunch({ url: "/pages/login/login" });
      },
    });
  },
});
