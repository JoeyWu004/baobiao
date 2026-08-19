// pages/quantity-history/quantity-history.js 商品数量变动记录
const { db } = require("../../utils/cloud");
const { fmtDateTime, toDate } = require("../../utils/format");

const SOURCE_MAP = { manual: "手动", invoice: "发票", report: "报表" };

Page({
  data: {
    productId: "",
    name: "",
    filter: "all", // all | manual | invoice | report
    list: [],
    loading: true,
  },

  onLoad(options) {
    const name = options.name ? decodeURIComponent(options.name) : "";
    this.setData({ productId: options.productId || "", name });
    if (name) wx.setNavigationBarTitle({ title: name + " · 数量记录" });
  },

  onShow() {
    this.load();
  },

  async load() {
    if (!this.data.productId) return;
    this.setData({ loading: true });
    try {
      const res = await db()
        .collection("quantityHistory")
        .where({ productId: this.data.productId })
        .orderBy("changeTime", "desc")
        .limit(100)
        .get();
      const list = res.data.map((h) => {
        const d = toDate(h.changeTime);
        const delta = Number(h.delta) || 0;
        return {
          ...h,
          timeText: d ? fmtDateTime(d) : "",
          sourceText: SOURCE_MAP[h.source] || h.source || "手动",
          deltaText: (delta > 0 ? "+" : "") + delta,
          deltaClass: delta > 0 ? "up" : delta < 0 ? "down" : "",
          afterText: Number(h.after),
        };
      });
      this.setData({ list });
    } catch (e) {
      console.error("数量记录加载失败", e);
      wx.showToast({ title: "加载失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  setFilter(e) {
    const filter = e.currentTarget.dataset.filter;
    if (filter === this.data.filter) return;
    this.setData({ filter });
  },

  // 长按记录删除
  onDeleteRecord(e) {
    const id = e.currentTarget.dataset.id;
    const record = this.data.list.find((it) => it._id === id);
    if (!record) return;
    wx.showModal({
      title: "删除记录",
      content: "确定删除这条数量变动记录吗？",
      confirmColor: "#fa5151",
      success: (res) => {
        if (!res.confirm) return;
        db()
          .collection("quantityHistory")
          .doc(id)
          .remove()
          .then(() => {
            wx.showToast({ title: "已删除" });
            this.load();
          })
          .catch((err) => {
            console.error("删除数量记录失败", err);
            wx.showToast({ title: "删除失败", icon: "none" });
          });
      },
    });
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },
});
