// pages/goods/edit.js 商品新增/编辑（支持多单位，各单位独立价格与库存）
const { db } = require("../../utils/cloud");
const { roundMoney } = require("../../utils/format");

Page({
  data: {
    mode: "add", // add | edit
    _id: "",
    form: {
      name: "",
      supplier: "",
      remark: "",
    },
    units: [{ name: "", costPrice: "", sellPrice: "", quantity: "" }],
    categoryPath: [], // 多级分类路径
    categoryText: "",
    showCategoryPicker: false,
    saving: false,
  },

  onLoad(options) {
    if (options.id) {
      this.setData({ mode: "edit", _id: options.id });
      wx.setNavigationBarTitle({ title: "编辑商品" });
      this.loadProduct(options.id);
    } else {
      wx.setNavigationBarTitle({ title: "新增商品" });
    }
  },

  numToText(n) {
    if (n === null || n === undefined || n === "") return "";
    return String(n);
  },

  async loadProduct(id) {
    try {
      const res = await db().collection("products").doc(id).get();
      const p = res.data;
      const catPath = Array.isArray(p.categoryPath)
        ? p.categoryPath
        : p.category
          ? [p.category]
          : [];
      // 多单位：优先 units，否则用旧的单字段
      let units;
      if (Array.isArray(p.units) && p.units.length) {
        units = p.units.map((u) => ({
          name: u.name || "",
          costPrice: this.numToText(u.costPrice),
          sellPrice: this.numToText(u.sellPrice),
          quantity: this.numToText(u.quantity),
        }));
      } else {
        units = [
          {
            name: p.unit || "",
            costPrice: this.numToText(p.costPrice),
            sellPrice: this.numToText(p.sellPrice),
            quantity: this.numToText(p.quantity),
          },
        ];
      }
      this.setData({
        form: { name: p.name || "", supplier: p.supplier || "", remark: p.remark || "" },
        units,
        categoryPath: catPath,
        categoryText: catPath.join(" / "),
      });
      this.oldUnits = units.map((u) => ({
        name: u.name,
        costPrice: parseFloat(u.costPrice) || 0,
        sellPrice: parseFloat(u.sellPrice) || 0,
        quantity: parseFloat(u.quantity) || 0,
      }));
    } catch (e) {
      console.error("商品加载失败", e);
      wx.showToast({ title: "加载失败", icon: "none" });
    }
  },

  onFormInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  onUnitInput(e) {
    const field = e.currentTarget.dataset.field; // name | costPrice | sellPrice | quantity
    const index = Number(e.currentTarget.dataset.index);
    this.setData({ [`units[${index}].${field}`]: e.detail.value });
  },

  // 库存步进：－/＋（库存允许为负）
  onQtyStep(e) {
    const index = Number(e.currentTarget.dataset.index);
    const delta = Number(e.currentTarget.dataset.delta) || 0;
    const units = this.data.units.slice();
    const u = units[index];
    if (!u) return;
    let cur = parseFloat(u.quantity);
    if (isNaN(cur)) cur = 0;
    u.quantity = String(cur + delta);
    this.setData({ units });
  },

  addUnit() {
    this.setData({
      units: [
        ...this.data.units,
        { name: "", costPrice: "", sellPrice: "", quantity: "" },
      ],
    });
  },

  removeUnit(e) {
    const index = Number(e.currentTarget.dataset.index);
    const units = this.data.units.slice();
    units.splice(index, 1);
    this.setData({
      units: units.length
        ? units
        : [{ name: "", costPrice: "", sellPrice: "", quantity: "" }],
    });
  },

  // ---------- 分类选择 ----------
  openCategoryPicker() {
    this.setData({ showCategoryPicker: true });
  },

  closeCategoryPicker() {
    this.setData({ showCategoryPicker: false });
  },

  onCategorySelect(e) {
    const path = e.detail.path || [];
    this.setData({
      categoryPath: path,
      categoryText: path.join(" / "),
      showCategoryPicker: false,
    });
  },

  // 解析 units 表单为有效单位数组
  parseUnits() {
    const parsed = [];
    for (const u of this.data.units) {
      const name = (u.name || "").trim();
      if (!name) continue;
      parsed.push({
        name,
        costPrice: roundMoney(parseFloat(u.costPrice) || 0),
        sellPrice: roundMoney(parseFloat(u.sellPrice) || 0),
        quantity: roundMoney(parseFloat(u.quantity) || 0),
      });
    }
    return parsed;
  },

  async onSave() {
    const f = this.data.form;
    if (!f.name.trim()) {
      wx.showToast({ title: "请填写商品名称", icon: "none" });
      return;
    }
    const parsed = this.parseUnits();
    if (!parsed.length) {
      wx.showToast({ title: "至少填写一个单位", icon: "none" });
      return;
    }
    for (const u of parsed) {
      if (u.costPrice < 0 || u.sellPrice < 0 || u.quantity < 0) {
        wx.showToast({ title: "价格/数量不能为负数", icon: "none" });
        return;
      }
    }

    const defaultUnit = parsed[0];
    const data = {
      name: f.name.trim(),
      units: parsed,
      unit: defaultUnit.name,
      costPrice: defaultUnit.costPrice,
      sellPrice: defaultUnit.sellPrice,
      quantity: defaultUnit.quantity,
      supplier: f.supplier.trim(),
      categoryPath: this.data.categoryPath,
      remark: f.remark.trim(),
      updateTime: db().serverDate(),
    };

    this.setData({ saving: true });
    try {
      if (this.data.mode === "add") {
        const addRes = await db().collection("products").add({
          data: { ...data, createTime: db().serverDate() },
        });
        await this.writeInitialQty(addRes._id, f.name.trim(), parsed);
        await this.writeInitialPrice(addRes._id, f.name.trim(), parsed);
      } else {
        await this.saveEdit(data);
      }
      wx.showToast({ title: "已保存" });
      setTimeout(() => wx.navigateBack(), 600);
    } catch (e) {
      console.error("保存失败", e);
      wx.showToast({ title: "保存失败", icon: "none" });
    } finally {
      this.setData({ saving: false });
    }
  },

  // 新增：各单位的初始库存记一条手动记录
  async writeInitialQty(productId, name, units) {
    for (const u of units) {
      if (u.quantity > 0) {
        await db().collection("quantityHistory").add({
          data: {
            productId,
            productName: name,
            delta: u.quantity,
            after: u.quantity,
            source: "manual",
            unit: u.name,
            reportId: null,
            changeTime: db().serverDate(),
          },
        });
      }
    }
  },

  // 新增：各单位的首次进价也算一次价格动作（oldPrice=0）
  async writeInitialPrice(productId, name, units) {
    for (const u of units) {
      if (u.costPrice > 0) {
        await db().collection("priceHistory").add({
          data: {
            productId,
            productName: name,
            priceType: "cost",
            oldPrice: 0,
            newPrice: u.costPrice,
            unit: u.name,
            changeTime: db().serverDate(),
          },
        });
      }
    }
  },

  // 编辑：按单位对比价格/数量变化写历史
  async saveEdit(data) {
    const id = this.data._id;
    const oldUnits = this.oldUnits || [];
    const newUnits = data.units;
    const priceChanges = [];
    const qtyChanges = [];

    for (const nu of newUnits) {
      const ou = oldUnits.find((o) => o.name === nu.name);
      if (ou) {
        if (Math.abs(ou.costPrice - nu.costPrice) > 0.001) {
          priceChanges.push({
            productId: id, productName: data.name, priceType: "cost",
            oldPrice: ou.costPrice, newPrice: nu.costPrice, unit: nu.name,
            changeTime: db().serverDate(),
          });
        }
        if (Math.abs(ou.sellPrice - nu.sellPrice) > 0.001) {
          priceChanges.push({
            productId: id, productName: data.name, priceType: "sell",
            oldPrice: ou.sellPrice, newPrice: nu.sellPrice, unit: nu.name,
            changeTime: db().serverDate(),
          });
        }
        const qtyDelta = roundMoney(nu.quantity - ou.quantity);
        if (Math.abs(qtyDelta) > 0.001) {
          qtyChanges.push({
            productId: id, productName: data.name, delta: qtyDelta, after: nu.quantity,
            source: "manual", unit: nu.name, reportId: null, changeTime: db().serverDate(),
          });
        }
      } else {
        // 新增单位：首次进价也算一次价格动作
        if (nu.costPrice > 0) {
          priceChanges.push({
            productId: id, productName: data.name, priceType: "cost",
            oldPrice: 0, newPrice: nu.costPrice, unit: nu.name,
            changeTime: db().serverDate(),
          });
        }
        if (nu.quantity > 0) {
          qtyChanges.push({
            productId: id, productName: data.name, delta: nu.quantity, after: nu.quantity,
            source: "manual", unit: nu.name, reportId: null, changeTime: db().serverDate(),
          });
        }
      }
    }

    await db().collection("products").doc(id).update({ data });
    for (const pc of priceChanges) await db().collection("priceHistory").add({ data: pc });
    for (const qc of qtyChanges) await db().collection("quantityHistory").add({ data: qc });
  },
});
