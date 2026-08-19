// components/goods-picker/index.js 商品选择弹层（多选 + 分类名搜索 + 一级分类筛选）
const { db } = require("../../utils/cloud");
const { fmtMoney } = require("../../utils/format");

Component({
  properties: {
    show: {
      type: Boolean,
      value: false,
    },
  },

  data: {
    keyword: "",
    list: [],
    filtered: [],
    loading: false,
    selectedProducts: [],
    selectedCount: 0,
    categories: ["全部"],
    activeCat: "全部",
  },

  observers: {
    show(val) {
      if (val) {
        // 每次打开重新加载，并清空上次的选择
        this.setData({ selectedProducts: [], selectedCount: 0 });
        this.reload();
      }
    },
  },

  methods: {
    // 商品的一级分类名
    catOf(p) {
      return Array.isArray(p.categoryPath) && p.categoryPath.length
        ? p.categoryPath[0]
        : p.category || "";
    },

    async reload() {
      this.setData({ loading: true, keyword: "", activeCat: "全部" });
      try {
        const res = await db()
          .collection("products")
          .orderBy("createTime", "desc")
          .limit(100)
          .get();
        const list = res.data
          .filter((p) => !p.deleted) // 回收站里的商品不显示
          .map((p) => ({
            ...p,
            sellPriceText: fmtMoney(p.sellPrice),
            costPriceText: fmtMoney(p.costPrice),
          }));
        // 一级分类列表（去重）
        const catSet = new Set();
        list.forEach((p) => {
          const c = this.catOf(p);
          if (c) catSet.add(c);
        });
        this.setData({ list, categories: ["全部", ...catSet] });
        this.applyFilter();
      } catch (e) {
        console.error("商品加载失败", e);
        wx.showToast({ title: "加载失败", icon: "none" });
      } finally {
        this.setData({ loading: false });
      }
    },

    // 按 关键字 + 一级分类 过滤，并标记选中态
    applyFilter() {
      const kw = this.data.keyword.trim().toLowerCase();
      const cat = this.data.activeCat;
      const ids = this.data.selectedProducts.map((p) => p._id);
      const filtered = this.data.list
        .filter((p) => {
          if (cat !== "全部") {
            const c = this.catOf(p);
            if (!c || c !== cat) return false;
          }
          if (!kw) return true;
          // 分类路径也参与搜索（任一级分类名都能命中）
          const pathText = (
            Array.isArray(p.categoryPath) ? p.categoryPath.join(" ") : p.category || ""
          ).toLowerCase();
          return (
            (p.name || "").toLowerCase().includes(kw) ||
            (p.supplier || "").toLowerCase().includes(kw) ||
            pathText.includes(kw)
          );
        })
        .map((it) => ({ ...it, _selected: ids.indexOf(it._id) > -1 }));
      this.setData({ filtered });
    },

    onSearch(e) {
      this.setData({ keyword: e.detail.value });
      this.applyFilter();
    },

    onCatTap(e) {
      const cat = e.currentTarget.dataset.cat || "全部";
      this.setData({ activeCat: cat });
      this.applyFilter();
    },

    onClose() {
      this.triggerEvent("close");
    },

    // 点商品：勾选 / 取消勾选
    onToggle(e) {
      const index = Number(e.currentTarget.dataset.index);
      const product = this.data.filtered[index];
      if (!product) return;
      const selectedProducts = this.data.selectedProducts.slice();
      const i = selectedProducts.findIndex((p) => p._id === product._id);
      if (i > -1) {
        selectedProducts.splice(i, 1);
      } else {
        selectedProducts.push(product);
      }
      const ids = selectedProducts.map((p) => p._id);
      const filtered = this.data.filtered.map((it) => ({
        ...it,
        _selected: ids.indexOf(it._id) > -1,
      }));
      this.setData({
        selectedProducts,
        selectedCount: selectedProducts.length,
        filtered,
      });
    },

    // 完成：有选择则批量返回，否则当作关闭
    onConfirm() {
      if (this.data.selectedProducts.length > 0) {
        this.triggerEvent("select", { products: this.data.selectedProducts });
      } else {
        this.triggerEvent("close");
      }
    },

    noop() {},
  },
});
