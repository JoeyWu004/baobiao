// pages/goods/goods.js 商品库列表
const { db } = require("../../utils/cloud");
const { fmtMoney } = require("../../utils/format");
const { ensureLogin } = require("../../utils/auth");
const recognition = require("../../utils/recognition");

Page({
  data: {
    list: [],
    filtered: [],
    keyword: "",
    loading: true,
    // 发票按钮角标（后台识别进度）
    recRunning: false,
    recPending: false,
    recDone: 0,
    recTotal: 0,
  },

  onShow() {
    ensureLogin(); // 登录态过期时弹出登录提示
    this.loadList();
    // 发票按钮角标：订阅识别任务状态
    this._unsub = recognition.subscribe((s) => this.applyRec(s));
    this.applyRec(recognition.getState());
    recognition.refresh();
  },

  onHide() {
    if (this._unsub) {
      this._unsub();
      this._unsub = null;
    }
  },

  applyRec(s) {
    const running = s.status === "running";
    const pending = s.status === "done" || s.status === "partial" || s.status === "failed";
    this.setData({
      recRunning: running,
      recPending: pending,
      recDone: s.done || 0,
      recTotal: s.total || 0,
    });
  },

  async loadList() {
    this.setData({ loading: true });
    try {
      // 翻页取全：小程序端单次查询最多返回 20 条，limit 传更大的值会被静默截断
      // （原来写 100 → 商品超过 20 个后，列表和顶部计数都只反映最近 20 个，
      //  搜索也只在这 20 个里过滤，老商品表现为「不见了」）
      const pageSize = 20;
      const all = [];
      for (;;) {
        const res = await db()
          .collection("products")
          .orderBy("createTime", "desc")
          .skip(all.length)
          .limit(pageSize)
          .get();
        if (!res.data || res.data.length === 0) break;
        all.push(...res.data);
        if (res.data.length < pageSize) break;
      }
      const list = all
        .filter((p) => !p.deleted) // 回收站里的商品不显示
        .map((p) => ({
          ...p,
          sellPriceText: fmtMoney(p.sellPrice),
          costPriceText: fmtMoney(p.costPrice),
          quantityText: Number(p.quantity) || 0,
          multiUnit: Array.isArray(p.units) && p.units.length > 1,
          categoryText: Array.isArray(p.categoryPath)
            ? p.categoryPath.join(" / ")
            : p.category || "",
        }));
      this.setData({ list });
      this.applyFilter();
    } catch (e) {
      console.error("商品列表加载失败", e);
      wx.showToast({ title: "加载失败，请检查云环境", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value });
    this.applyFilter();
  },

  applyFilter() {
    const kw = this.data.keyword.trim();
    let filtered = this.data.list;
    if (kw) {
      const lower = kw.toLowerCase();
      filtered = this.data.list.filter(
        (p) =>
          (p.name || "").toLowerCase().includes(lower) ||
          (p.supplier || "").toLowerCase().includes(lower)
      );
    }
    this.setData({ filtered });
  },

  goAdd() {
    wx.navigateTo({ url: "/pages/goods/edit" });
  },

  goCategory() {
    wx.navigateTo({ url: "/pages/category/category" });
  },

  goInvoice() {
    wx.navigateTo({ url: "/pages/invoice/invoice" });
  },

  goQtyHistory(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    wx.navigateTo({
      url: `/pages/quantity-history/quantity-history?productId=${id}&name=${encodeURIComponent(name)}`,
    });
  },

  goSource(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/goods-source/goods-source?id=${id}` });
  },

  goEdit(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: "/pages/goods/edit?id=" + id });
  },

  goHistory(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    wx.navigateTo({
      url: `/pages/price-history/price-history?productId=${id}&name=${encodeURIComponent(name)}`,
    });
  },

  onDelete(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    wx.showModal({
      title: "删除商品",
      content: `确定删除「${name}」吗？删除后进入回收站，可在回收站恢复。历史报表不受影响。`,
      confirmColor: "#fa5151",
      success: async (res) => {
        if (!res.confirm) return;
        try {
          // 软删除：移入回收站，可在回收站恢复 / 彻底删除
          await db()
            .collection("products")
            .doc(id)
            .update({ data: { deleted: true, deleteTime: db().serverDate() } });
          wx.showToast({ title: "已移入回收站" });
          this.loadList();
        } catch (err) {
          console.error("删除失败", err);
          wx.showToast({ title: "删除失败", icon: "none" });
        }
      },
    });
  },
});
