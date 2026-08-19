// components/category-picker/index.js 多级分类选择（下钻式）
const { db } = require("../../utils/cloud");

Component({
  properties: {
    show: {
      type: Boolean,
      value: false,
    },
  },

  data: {
    level: [], // 当前层级分类
    breadcrumb: [], // 已选路径 [{id,name}]
    pathText: "",
    loading: false,
    showAddModal: false,
    addName: "",
  },

  observers: {
    show(val) {
      if (val) {
        this.reset();
        this.loadAll();
      }
    },
  },

  methods: {
    reset() {
      this.setData({ level: [], breadcrumb: [], pathText: "" });
      this._all = [];
    },

    async loadAll() {
      this.setData({ loading: true });
      try {
        const res = await db().collection("categories").get();
        this._all = res.data;
        this.goTo(null, []);
      } catch (e) {
        console.error("分类加载失败", e);
        wx.showToast({ title: "加载失败", icon: "none" });
      } finally {
        this.setData({ loading: false });
      }
    },

    // 进入某个父分类
    goTo(parentId, breadcrumb) {
      const level = (this._all || []).filter((c) => c.parentId === parentId);
      this.setData({
        level,
        breadcrumb,
        pathText: breadcrumb.map((c) => c.name).join(" / "),
      });
    },

    tapNode(e) {
      const id = e.currentTarget.dataset.id;
      const node = (this._all || []).find((n) => n._id === id);
      if (!node) return;
      const hasChildren = (this._all || []).some((n) => n.parentId === id);
      if (hasChildren) {
        this.goTo(id, [...this.data.breadcrumb, { id, name: node.name }]);
      } else {
        // 叶子：直接选中
        const path = [...this.data.breadcrumb.map((c) => c.name), node.name];
        this.triggerEvent("select", { path });
      }
    },

    // 返回上一级
    goBack() {
      const crumb = this.data.breadcrumb;
      if (!crumb.length) return;
      const next = crumb.slice(0, -1);
      const parentId = next.length ? next[next.length - 1].id : null;
      this.goTo(parentId, next);
    },

    // 选择当前层（不再下钻）
    confirm() {
      this.triggerEvent("select", {
        path: this.data.breadcrumb.map((c) => c.name),
      });
    },

    // ---------- 在当前层级新增分类 ----------
    openAddModal() {
      this.setData({ showAddModal: true, addName: "" });
    },

    closeAddModal() {
      this.setData({ showAddModal: false });
    },

    onAddInput(e) {
      this.setData({ addName: e.detail.value });
    },

    async confirmAdd() {
      const name = this.data.addName.trim();
      if (!name) {
        wx.showToast({ title: "请输入分类名称", icon: "none" });
        return;
      }
      const crumb = this.data.breadcrumb;
      const parentId = crumb.length ? crumb[crumb.length - 1].id : null;
      try {
        await db().collection("categories").add({
          data: {
            name,
            level: crumb.length,
            parentId,
            sort: Date.now(),
            createTime: db().serverDate(),
          },
        });
        this.setData({ showAddModal: false, addName: "" });
        wx.showToast({ title: "已新增" });
        await this.reloadCurrent();
      } catch (e) {
        console.error("新增分类失败", e);
        wx.showToast({ title: "新增失败", icon: "none" });
      }
    },

    // 重新加载并停留在当前层级
    async reloadCurrent() {
      const res = await db().collection("categories").get();
      this._all = res.data;
      const crumb = this.data.breadcrumb;
      const parentId = crumb.length ? crumb[crumb.length - 1].id : null;
      this.goTo(parentId, crumb);
    },

    onClose() {
      this.triggerEvent("close");
    },

    noop() {},
  },
});
