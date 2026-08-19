// pages/invoice/invoice.js 上传供货商发票（支持多张）→ 后台逐张识别
// 点击「识别全部」只把任务落库并返回，上传/识别由 utils/recognition 在后台推进；
// 再次进入本页时若任务在跑/已完成，顶部横幅显示进度与「去确认」。
const recognition = require("../../utils/recognition");

Page({
  data: {
    images: [], // 待识别图片 [{ path, digest }]，digest 用于防重复
    starting: false, // 正在提交任务
    // 后台任务状态（进入本页时展示）
    hasJob: false,
    jobStatus: "", // running | done | partial | failed | ...
    jobTotal: 0,
    jobDone: 0,
    jobSuccess: 0,
    jobFailed: 0,
  },

  onShow() {
    this._unsub = recognition.subscribe((s) => this.applyJob(s));
    this.applyJob(recognition.getState());
    recognition.refresh(); // 从数据库同步（如被杀后恢复）
  },

  onHide() {
    this.unsubscribe();
  },

  onUnload() {
    this.unsubscribe();
  },

  unsubscribe() {
    if (this._unsub) {
      this._unsub();
      this._unsub = null;
    }
  },

  applyJob(s) {
    const hasJob = !!s.jobId && ["running", "done", "partial", "failed"].indexOf(s.status) >= 0;
    this.setData({
      hasJob,
      jobStatus: s.status || "",
      jobTotal: s.total || 0,
      jobDone: s.done || 0,
      jobSuccess: s.success || 0,
      jobFailed: s.failed || 0,
    });
  },

  chooseImage() {
    wx.chooseMedia({
      count: 9, // 单次最多 9 张；可多次添加，不限总数
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: (res) => {
        const files = (res.tempFiles || []).map((f) => f.tempFilePath).filter(Boolean);
        if (files.length) this.addImages(files);
      },
    });
  },

  // 逐张计算内容指纹（md5），与已选图片去重后加入
  async addImages(files) {
    const existing = this.data.images; // [{ path, digest }]
    const seen = new Set(existing.map((im) => im.digest).filter(Boolean));
    const added = [];
    let dup = 0;
    for (const path of files) {
      let digest = "";
      try {
        digest = await this.digestOf(path);
      } catch (e) {
        console.error("计算图片指纹失败", e);
      }
      if (digest && seen.has(digest)) {
        dup += 1;
        continue;
      }
      if (digest) seen.add(digest);
      added.push({ path, digest });
    }
    if (added.length) this.setData({ images: [...existing, ...added] });
    if (dup > 0) wx.showToast({ title: `已跳过 ${dup} 张重复发票`, icon: "none" });
  },

  digestOf(filePath) {
    return new Promise((resolve, reject) => {
      wx.getFileInfo({
        filePath,
        success: (r) => resolve(r.digest || ""),
        fail: reject,
      });
    });
  },

  removeImage(e) {
    const index = Number(e.currentTarget.dataset.index);
    const images = this.data.images.slice();
    images.splice(index, 1);
    this.setData({ images });
  },

  clearAll() {
    this.setData({ images: [] });
  },

  // 启动后台识别：任务落库后立即返回，识别在后台静默进行
  async onRecognize() {
    const images = this.data.images;
    if (!images.length || this.data.starting) return;
    if (this.data.hasJob && this.data.jobStatus === "running") {
      wx.showToast({ title: "已有识别任务进行中", icon: "none" });
      return;
    }
    // 历史去重：对比之前已成功识别过的发票指纹
    let seenSet = null;
    try {
      seenSet = await recognition.seenDigests();
    } catch (e) {}
    const dupSeen =
      seenSet && seenSet.size
        ? images.filter((im) => im.digest && seenSet.has(im.digest)).length
        : 0;
    if (dupSeen > 0) {
      const rest = images.filter((im) => !(im.digest && seenSet.has(im.digest)));
      wx.showModal({
        title: "发现重复发票",
        content: `${dupSeen} 张发票之前已识别过，可能已入库。是否跳过并只识别剩余 ${rest.length} 张？`,
        confirmText: "继续",
        cancelText: "取消",
        success: (r) => {
          if (!r.confirm) return;
          if (!rest.length) {
            wx.showToast({ title: "全部为重复发票，无需识别", icon: "none" });
            return;
          }
          this.submit(rest);
        },
      });
      return;
    }
    await this.submit(images);
  },

  // 提交识别任务（已剔除重复）
  async submit(images) {
    if (!images.length) return;
    this.setData({ starting: true });
    wx.showLoading({ title: "提交中…", mask: true });
    try {
      await recognition.createJob(images);
      wx.hideLoading();
      wx.showToast({ title: `已开始后台识别 ${images.length} 张` });
      setTimeout(() => wx.navigateBack(), 600);
    } catch (e) {
      wx.hideLoading();
      this.setData({ starting: false });
      wx.showModal({
        title: "无法启动识别",
        content: (e && e.message) || "请稍后再试",
        showCancel: false,
      });
    }
  },

  goConfirm() {
    wx.navigateTo({ url: "/pages/invoice-confirm/invoice-confirm" });
  },

  // 取消后台识别任务
  onCancelJob() {
    wx.showModal({
      title: "取消识别",
      content: "将停止后台识别，已识别的结果不再提示确认。",
      confirmColor: "#fa5151",
      success: async (r) => {
        if (!r.confirm) return;
        await recognition.cancel();
        wx.showToast({ title: "已取消" });
        this.setData({ images: [] });
      },
    });
  },
});
