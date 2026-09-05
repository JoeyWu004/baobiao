// pages/quantity-history/quantity-history.js 商品数量变动记录
const { db, callReportOps } = require("../../utils/cloud");
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

  // 重建数量记录：按该商品全部数量记录（含手动，手动真实增减）重算当前库存
  async onRebuildQty() {
    const pid = this.data.productId;
    if (!pid) return;
    wx.showLoading({ title: "计算中…" });
    try {
      const res = await callReportOps("rebuildQuantity", { productId: pid, dryRun: true });
      const r = res.result;
      if (!r || !r.success) {
        wx.showToast({ title: (r && r.msg) || "计算失败", icon: "none" });
        return;
      }
      let lines = Object.keys(r.computed).map(
        (u) => `${u}: ${Number(r.old[u]) || 0} → ${Number(r.computed[u]) || 0}`
      );
      if (lines.length > 5) {
        lines = lines.slice(0, 5).concat("…");
      }
      const content =
        "将按该商品全部数量变动记录（含手动，手动真实增减）重算库存，并保留所有记录；是否删除旧手动记录由你随后自行决定。\n\n" +
        lines.join("\n") +
        "\n\n确认重建？";
      wx.showModal({
        title: "重建数量记录",
        content,
        confirmColor: "#fa5151",
        success: (res2) => {
          if (res2.confirm) this._doRebuild(pid);
        },
      });
    } catch (e) {
      console.error("重建预览失败", e);
      wx.showToast({ title: "计算失败", icon: "none" });
    } finally {
      wx.hideLoading();
    }
  },

  async _doRebuild(pid) {
    wx.showLoading({ title: "重建中…" });
    try {
      const res = await callReportOps("rebuildQuantity", { productId: pid, dryRun: false });
      const r = res.result;
      if (r && r.success) {
        wx.showToast({ title: "已重建", icon: "success" });
        this.load();
      } else {
        wx.showToast({ title: (r && r.msg) || "重建失败", icon: "none" });
      }
    } catch (e) {
      console.error("重建失败", e);
      wx.showToast({ title: "重建失败", icon: "none" });
    } finally {
      wx.hideLoading();
    }
  },
});
