// pages/category-goods/category-goods.js 某分类下的商品列表
const { db } = require("../../utils/cloud");
const { fmtMoney } = require("../../utils/format");

function pathStartsWith(arr, prefix) {
  if (prefix.length > arr.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (arr[i] !== prefix[i]) return false;
  }
  return true;
}

// 分类匹配：兼容商品只存了叶子分类名（如 ["指纹锁"]）、树里是完整路径（如 ["智能锁","指纹锁"]）的情况。
// 满足其一即命中：① 短路径正好是长路径从头开始的前缀；② 短路径正好是长路径的结尾。
function catMatch(cp, np) {
  if (!Array.isArray(cp) || !cp.length || !Array.isArray(np) || !np.length) return false;
  const longer = cp.length >= np.length ? cp : np;
  const shorter = cp.length >= np.length ? np : cp;
  if (shorter.every((x, i) => x === longer[i])) return true; // 前缀
  const start = longer.length - shorter.length;
  return shorter.every((x, i) => x === longer[start + i]); // 结尾
}

Page({
  data: {
    path: [],
    name: "",
    list: [],
    loading: true,
  },

  onLoad(options) {
    let path = [];
    try {
      path = JSON.parse(decodeURIComponent(options.path || "[]"));
    } catch (e) {}
    const name = options.name ? decodeURIComponent(options.name) : "";
    this.setData({ path, name });
    if (name) wx.setNavigationBarTitle({ title: name + " · 商品" });
  },

  onShow() {
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      // 翻页取全（小程序端单次最多 20 条）
      const all = [];
      {
        const pageSize = 20;
        let offset = 0;
        for (;;) {
          const res = await db()
            .collection("products")
            .orderBy("createTime", "desc")
            .skip(offset)
            .limit(pageSize)
            .get();
          if (!res.data || res.data.length === 0) break;
          all.push(...res.data);
          offset += res.data.length;
          if (res.data.length < pageSize) break;
        }
      }
      const path = this.data.path;
      const list = all
        .filter((p) => {
          if (p.deleted) return false; // 回收站里的商品不显示
          const cp = Array.isArray(p.categoryPath)
            ? p.categoryPath
            : p.category
              ? [p.category]
              : [];
          return catMatch(cp, path);
        })
        .map((p) => ({
          ...p,
          sellPriceText: fmtMoney(p.sellPrice),
          costPriceText: fmtMoney(p.costPrice),
          categoryText: (
            Array.isArray(p.categoryPath)
              ? p.categoryPath
              : p.category
                ? [p.category]
                : []
          ).join(" / "),
        }));
      this.setData({ list });
    } catch (e) {
      console.error("分类商品加载失败", e);
      wx.showToast({ title: "加载失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  goHistory(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    wx.navigateTo({
      url: `/pages/price-history/price-history?productId=${id}&name=${encodeURIComponent(name)}`,
    });
  },

  goEdit(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: "/pages/goods/edit?id=" + id });
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
          this.load();
        } catch (err) {
          console.error("删除失败", err);
          wx.showToast({ title: "删除失败", icon: "none" });
        }
      },
    });
  },
});
