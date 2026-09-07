// pages/category/category.js 自定义多级分类管理
const { db } = require("../../utils/cloud");

// 判断数组是否以 prefix 开头
function pathStartsWith(arr, prefix) {
  if (prefix.length > arr.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (arr[i] !== prefix[i]) return false;
  }
  return true;
}

// 分类匹配：兼容商品只存了叶子分类名（如 ["指纹锁"]）、树里是完整路径（如 ["智能锁","指纹锁"]）的情况。
// 满足其一即命中：① 短路径正好是长路径从头开始的前缀（商品在点击分类的子树里）；② 短路径正好是长路径的结尾。
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
    nodes: [], // 可见的扁平节点（含缩进深度）
    loading: true,
    // 输入弹窗
    showModal: false,
    modalTitle: "",
    modalValue: "",
    modalMode: "add", // add | edit
    modalParentId: null,
    modalLevel: 0,
    editingId: "",
  },

  onShow() {
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      const res = await db()
        .collection("categories")
        .orderBy("level", "asc")
        .orderBy("sort", "asc")
        .get();
      this._all = res.data;
      this.rebuild();
    } catch (e) {
      console.error("分类加载失败", e);
      wx.showToast({ title: "加载失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  // 生成完整树形扁平列表（始终全部展开，不折叠）
  rebuild() {
    const childrenMap = {};
    (this._all || []).forEach((c) => {
      (childrenMap[c.parentId] = childrenMap[c.parentId] || []).push(c);
    });
    const nodes = [];
    const walk = (parentId, depth, path) => {
      (childrenMap[parentId] || []).forEach((c) => {
        const p = [...path, c.name];
        nodes.push({ ...c, depth, path: p, indent: Math.min(depth, 6) * 30 + 12 });
        walk(c._id, depth + 1, p); // 子分类始终展开
      });
    };
    walk(null, 0, []);
    this._nodes = nodes;
    this.setData({ nodes });
  },

  // 点击分类：若该分类（含子级）下有商品，进入分类商品页
  async onTapCategory(e) {
    if (this._longPressed) {
      this._longPressed = false;
      return;
    }
    const id = e.currentTarget.dataset.id;
    const node = (this._nodes || []).find((n) => n._id === id);
    if (!node) return;
    try {
      // 翻页取全（小程序端单次最多 20 条；含回收站文档也要跳过，避免漏判）
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
      const matched = all.filter((p) => {
        if (p.deleted) return false; // 回收站里的商品不计入
        const cp = Array.isArray(p.categoryPath)
          ? p.categoryPath
          : p.category
            ? [p.category]
            : [];
        return catMatch(cp, node.path);
      });
      if (matched.length === 0) {
        wx.showToast({ title: "该分类暂无商品", icon: "none" });
        return;
      }
      wx.navigateTo({
        url:
          "/pages/category-goods/category-goods?path=" +
          encodeURIComponent(JSON.stringify(node.path)) +
          "&name=" +
          encodeURIComponent(node.name),
      });
    } catch (err) {
      console.error("查询分类商品失败", err);
      wx.showToast({ title: "查询失败", icon: "none" });
    }
  },

  // ---------- 新增 ----------
  openAddRoot() {
    this.setData({
      showModal: true,
      modalTitle: "新增一级分类",
      modalValue: "",
      modalMode: "add",
      modalParentId: null,
      modalLevel: 0,
      editingId: "",
    });
  },

  // 长按分类名 → 弹出右键式菜单
  onLongPress(e) {
    this._longPressed = true;
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    const level = Number(e.currentTarget.dataset.level);
    wx.showActionSheet({
      itemList: ["添加子分类", "重命名", "删除分类"],
      success: (res) => {
        if (res.tapIndex === 0) this.openAddChild(id, level);
        else if (res.tapIndex === 1) this.openEdit(id, name);
        else if (res.tapIndex === 2) this.deleteCategory(id, name);
      },
    });
  },

  openAddChild(id, level) {
    this.setData({
      showModal: true,
      modalTitle: "添加子分类",
      modalValue: "",
      modalMode: "add",
      modalParentId: id,
      modalLevel: level + 1,
      editingId: "",
    });
  },

  openEdit(id, name) {
    this.setData({
      showModal: true,
      modalTitle: "重命名分类",
      modalValue: name,
      modalMode: "edit",
      editingId: id,
    });
  },

  onModalInput(e) {
    this.setData({ modalValue: e.detail.value });
  },

  noop() {},

  closeModal() {
    this.setData({ showModal: false });
  },

  async confirmModal() {
    const name = this.data.modalValue.trim();
    if (!name) {
      wx.showToast({ title: "请输入分类名称", icon: "none" });
      return;
    }
    try {
      if (this.data.modalMode === "add") {
        await db().collection("categories").add({
          data: {
            name,
            level: this.data.modalLevel,
            parentId: this.data.modalParentId,
            sort: Date.now(), // 新的排后面，向下堆叠
            createTime: db().serverDate(),
          },
        });
      } else {
        await db()
          .collection("categories")
          .doc(this.data.editingId)
          .update({ data: { name } });
      }
      this.setData({ showModal: false });
      this.load();
    } catch (e) {
      console.error("分类保存失败", e);
      wx.showToast({ title: "保存失败", icon: "none" });
    }
  },

  // ---------- 删除（连子级 + 清空引用该分类的商品） ----------
  deleteCategory(id, name) {
    wx.showModal({
      title: "删除分类",
      content: `确定删除「${name}」及其所有子分类吗？已分配该分类的商品分类会被清空。`,
      confirmColor: "#fa5151",
      success: async (res) => {
        if (!res.confirm) return;
        const ids = new Set([id]);
        const collect = (pid) => {
          (this._all || []).forEach((c) => {
            if (c.parentId === pid && !ids.has(c._id)) {
              ids.add(c._id);
              collect(c._id);
            }
          });
        };
        collect(id);
        try {
          for (const cid of ids) {
            await db().collection("categories").doc(cid).remove();
          }
          // 清空引用了该分类名称的商品分类路径
          const prodRes = await db()
            .collection("products")
            .where({ categoryPath: name })
            .get();
          for (const p of prodRes.data) {
            await db()
              .collection("products")
              .doc(p._id)
              .update({ data: { categoryPath: [] } });
          }
          wx.showToast({ title: "已删除" });
          this.load();
        } catch (err) {
          console.error("删除分类失败", err);
          wx.showToast({ title: "删除失败", icon: "none" });
        }
      },
    });
  },
});
