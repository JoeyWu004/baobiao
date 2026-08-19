// components/recognition-float/recognition-float.js 后台识别完成弹窗
// 挂到 4 个 tab 页：任务完成时在「当前可见页」中下位置弹出，3 秒自动消失，可点「去确认」。
// 通过 recognition.lastNotified/markNotified 保证同一任务只弹一次；
// 完成发生在非 tab 页时，回到任意 tab 页后由 pageLifetimes.show 补弹。
const recognition = require("../../utils/recognition");

Component({
  data: {
    visible: false,
    total: 0,
    success: 0,
    failed: 0,
  },

  lifetimes: {
    attached() {
      this._route = "";
      const pages = getCurrentPages();
      if (pages.length) this._route = pages[pages.length - 1].route;
      this._unsub = recognition.subscribe((s) => this.onState(s));
    },
    detached() {
      if (this._unsub) this._unsub();
      this._unsub = null;
      if (this._timer) clearTimeout(this._timer);
    },
  },

  pageLifetimes: {
    show() {
      // 从其他页面回到 tab 页时，若完成弹窗还没提示过则补弹
      this.onState(recognition.getState());
    },
  },

  methods: {
    onState(s) {
      if ((s.status !== "done" && s.status !== "partial") || !s.jobId) return;
      // 只在本组件所在页为当前页时弹，否则等 pageLifetimes.show 补弹
      const pages = getCurrentPages();
      const cur = pages.length ? pages[pages.length - 1].route : "";
      if (cur !== this._route) return;
      if (recognition.lastNotified() === s.jobId) return;
      recognition.markNotified(s.jobId);
      this.setData({
        visible: true,
        total: s.total || 0,
        success: s.success || 0,
        failed: s.failed || 0,
      });
      if (this._timer) clearTimeout(this._timer);
      this._timer = setTimeout(() => this.setData({ visible: false }), 3000);
    },
    goConfirm() {
      if (this._timer) clearTimeout(this._timer);
      this.setData({ visible: false });
      wx.navigateTo({ url: "/pages/invoice-confirm/invoice-confirm" });
    },
  },
});
