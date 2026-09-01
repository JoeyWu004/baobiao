// pages/goods-source/goods-source.js 商品来源
const { db } = require("../../utils/cloud");
const { fmtDate, toDate } = require("../../utils/format");

Page({
  data: {
    loading: true,
    name: "",
    unit: "",
    sourceType: "", // manual | invoice | purchase | unknown
    sourceLabel: "",
    sourceSupplier: "",
    sourceDate: "",
    purchaseId: "",
  },

  onLoad(options) {
    this.productId = options.id || "";
    this.load();
  },

  async load() {
    if (!this.productId) {
      this.setData({ loading: false });
      return;
    }
    try {
      const res = await db().collection("products").doc(this.productId).get();
      const p = res.data || {};
      const s = p.source || null;

      let sourceType = "unknown";
      let sourceLabel = "未知来源";
      let sourceSupplier = "";
      let sourceDate = "";
      let purchaseId = "";

      if (s && s.type === "manual") {
        sourceType = "manual";
        sourceLabel = "手动录入";
        const d = toDate(p.createTime);
        sourceDate = d ? fmtDate(d) : "";
      } else if (s && s.type === "restore") {
        sourceType = "restore";
        sourceLabel = "报表恢复";
        const d = toDate(p.createTime);
        sourceDate = d ? fmtDate(d) : "";
      } else if (s && (s.type === "invoice" || s.type === "purchase")) {
        sourceType = s.type;
        sourceLabel = s.type === "invoice" ? "发票导入" : "进货记录";
        sourceSupplier = s.supplier || "";
        sourceDate = s.date || "";
        purchaseId = s.purchaseId || "";
      }

      this.setData({
        loading: false,
        name: p.name || "",
        unit: p.unit || "",
        sourceType,
        sourceLabel,
        sourceSupplier,
        sourceDate,
        purchaseId,
      });
    } catch (e) {
      console.error("商品来源加载失败", e);
      wx.showToast({ title: "加载失败", icon: "none" });
      this.setData({ loading: false });
    }
  },

  goPurchase() {
    if (!this.data.purchaseId) return;
    wx.navigateTo({
      url: "/pages/purchase-detail/purchase-detail?id=" + this.data.purchaseId,
    });
  },
});
