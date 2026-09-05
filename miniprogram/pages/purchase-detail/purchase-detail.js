// pages/purchase-detail/purchase-detail.js 进货明细
const { db, callReportOps } = require("../../utils/cloud");
const { fmtMoney, fmtDate, roundMoney } = require("../../utils/format");

Page({
  data: {
    purchase: null,
    items: [],
    totalText: "0.00",
    imageUrl: "",
    loading: true,
    saving: false,
    modelLabel: "",
  },

  onLoad(options) {
    this.purchaseId = options.id || "";
    this._uid = 0;
    this.load();
  },

  newUid() {
    this._uid += 1;
    return "p-" + this._uid;
  },

  // 识别模型 id → 展示名（进货详情页标注识别这张发票用的模型）
  modelLabel(value) {
    const m = String(value || "");
    if (/^kimi-k2/i.test(m)) return "Kimi K2.6";
    if (/^kimi-k3/i.test(m)) return "Kimi K3";
    if (/^deepseek/i.test(m)) return "DeepSeek V4 Flash";
    return m || "";
  },

  async load() {
    if (!this.purchaseId) return;
    this.setData({ loading: true });
    try {
      const res = await db().collection("purchases").doc(this.purchaseId).get();
      const p = res.data;
      const items = (p.items || []).map((it) => {
        const quantity = Number(it.quantity) || 0;
        const price = Number(it.price) || 0;
        const amount = roundMoney(Number(it.amount) || price * quantity);
        return {
          uid: this.newUid(),
          name: it.name || "",
          origName: it.name || "", // 记录原始名，供改名并同步判断旧名
          unit: it.unit || "个",
          quantity,
          price,
          amount,
          amountText: fmtMoney(amount),
        };
      });
      this.setData({
        purchase: p,
        items,
        totalText: fmtMoney(p.totalAmount || items.reduce((s, it) => s + it.amount, 0)),
        modelLabel: this.modelLabel(p.model),
      });
      // 发票图片
      if (p.fileID) {
        wx.cloud
          .getTempFileURL({ fileList: [p.fileID] })
          .then((r) => {
            const f = r.fileList && r.fileList[0];
            if (f && f.tempFileURL) this.setData({ imageUrl: f.tempFileURL });
          })
          .catch(() => {});
      }
    } catch (e) {
      console.error("进货明细加载失败", e);
      wx.showToast({ title: "加载失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  previewImg(e) {
    const url = e.currentTarget.dataset.src;
    wx.previewImage({ urls: [url] });
  },

  // ---------- 编辑 ----------
  onSupplierInput(e) {
    this.setData({ "purchase.supplier": e.detail.value });
  },

  onDateChange(e) {
    this.setData({ "purchase.date": e.detail.value });
  },

  onItemInput(e) {
    const field = e.currentTarget.dataset.field; // name | unit | quantity | price
    const index = Number(e.currentTarget.dataset.index);
    const items = this.data.items.slice();
    const item = { ...items[index] };
    if (!item) return;
    // 数量/单价保留原始字符串：立即 Number() 会吞掉输入中的小数点，导致无法输入小数
    item[field] = e.detail.value;
    items[index] = item;
    this.setData({ items });
    this.recalc();
  },

  addItem() {
    this.setData({
      items: [
        ...this.data.items,
        { uid: this.newUid(), name: "", unit: "个", quantity: 1, price: 0, amount: 0 },
      ],
    });
    this.recalc();
  },

  removeItem(e) {
    const index = Number(e.currentTarget.dataset.index);
    const items = this.data.items.slice();
    items.splice(index, 1);
    this.setData({ items });
    this.recalc();
  },

  recalc() {
    const items = this.data.items.map((it) => {
      const amount = roundMoney(Number(it.price) * Number(it.quantity));
      return { ...it, amount, amountText: fmtMoney(amount) };
    });
    const total = roundMoney(items.reduce((s, it) => s + it.amount, 0));
    this.setData({ items, totalText: fmtMoney(total) });
  },

  // 按进货记录编辑前后明细，对商品库库存/进价做增量修正（只补差额，可重复编辑）
  async syncStock(oldItems, newItems, supplier) {
    const agg = (arr) => {
      const m = {};
      (arr || []).forEach((it) => {
        const name = (it.name || "").trim();
        if (!name) return;
        const unit = (it.unit || "").trim() || "个";
        const key = name + "" + unit;
        if (!m[key]) m[key] = { name, unit, qty: 0, price: 0 };
        m[key].qty = roundMoney(m[key].qty + (Number(it.quantity) || 0));
        m[key].price = roundMoney(Number(it.price) || 0);
      });
      return m;
    };
    const oldMap = agg(oldItems);
    const newMap = agg(newItems);
    const keys = [...new Set([...Object.keys(oldMap), ...Object.keys(newMap)])];

    for (const key of keys) {
      const [name, unitName] = key.split("");
      const old = oldMap[key] || { qty: 0, price: 0 };
      const now = newMap[key] || { qty: 0, price: 0 };
      const delta = roundMoney(now.qty - old.qty);
      const priceChanged = now.price > 0 && Math.abs(now.price - old.price) > 0.001;

      const found = await db().collection("products").where({ name }).limit(1).get();
      let product = found.data[0];
      // 已删除（回收站）的商品视为不存在，重新建档
      if (product && product.deleted) product = null;

      // 商品不存在：编辑后仍有数量就新建
      if (!product) {
        if (now.qty > 0) {
          const addRes = await db().collection("products").add({
            data: {
              name,
              units: [{ name: unitName, costPrice: now.price, sellPrice: 0, quantity: now.qty }],
              unit: unitName,
              costPrice: now.price,
              sellPrice: 0,
              quantity: now.qty,
              supplier,
              categoryPath: [],
              remark: "",
              source: {
                type: "purchase",
                purchaseId: this.purchaseId,
                date: (this.data.purchase && this.data.purchase.date) || "",
                supplier,
              },
              createTime: db().serverDate(),
              updateTime: db().serverDate(),
            },
          });
          await db().collection("quantityHistory").add({
            data: {
              productId: addRes._id, productName: name, delta: now.qty,
              after: now.qty, source: "purchase-edit", unit: unitName,
              reportId: null, changeTime: db().serverDate(),
            },
          });
        }
        // 新建商品：首次进价也算一次价格动作
        if (now.price > 0) {
          await db().collection("priceHistory").add({
            data: {
              productId: addRes._id, productName: name, priceType: "cost",
              oldPrice: 0, newPrice: now.price, unit: unitName,
              changeTime: db().serverDate(),
            },
          });
        }
        continue;
      }

      let units = Array.isArray(product.units) && product.units.length
        ? product.units.slice()
        : [{ name: product.unit || "个", costPrice: product.costPrice || 0, sellPrice: product.sellPrice || 0, quantity: product.quantity || 0 }];
      let idx = units.findIndex((u) => u.name === unitName);
      let changed = false;

      if (idx < 0) {
        // 该商品下新增单位
        if (delta !== 0 || now.qty > 0) {
          units.push({ name: unitName, costPrice: now.price || 0, sellPrice: 0, quantity: now.qty });
          idx = units.length - 1;
          changed = true;
          // 新增单位：首次进价也算一次价格动作
          if (now.price > 0) {
            await db().collection("priceHistory").add({
              data: {
                productId: product._id, productName: name, priceType: "cost",
                oldPrice: 0, newPrice: now.price, unit: unitName,
                changeTime: db().serverDate(),
              },
            });
          }
          if (now.qty > 0) {
            await db().collection("quantityHistory").add({
              data: {
                productId: product._id, productName: name, delta: now.qty,
                after: now.qty, source: "purchase-edit", unit: unitName,
                reportId: null, changeTime: db().serverDate(),
              },
            });
          }
        }
      } else {
        const unit = { ...units[idx] };
        // 数量差额
        if (delta !== 0) {
          const before = roundMoney(Number(unit.quantity || 0));
          const after = roundMoney(before + delta); // 库存允许为负
          const appliedDelta = roundMoney(after - before);
          if (appliedDelta !== 0) {
            unit.quantity = after;
            units[idx] = unit;
            changed = true;
            await db().collection("quantityHistory").add({
              data: {
                productId: product._id, productName: name, delta: appliedDelta,
                after, source: "purchase-edit", unit: unitName,
                reportId: null, changeTime: db().serverDate(),
              },
            });
          }
        }
        // 进价修正：仅当商品当前成本价仍是旧进价（即本记录是定价来源）才覆盖
        if (priceChanged && Math.abs(Number(unit.costPrice || 0) - old.price) < 0.001) {
          const oldPrice = Number(unit.costPrice || 0);
          const newPrice = now.price;
          unit.costPrice = newPrice;
          units[idx] = unit;
          changed = true;
          await db().collection("priceHistory").add({
            data: {
              productId: product._id, productName: name, priceType: "cost",
              oldPrice, newPrice, unit: unitName, changeTime: db().serverDate(),
            },
          });
        }
      }

      if (changed) {
        const updateData = { units, supplier, updateTime: db().serverDate() };
        if (units[0].name === unitName) {
          updateData.unit = units[0].name;
          updateData.costPrice = Number(units[0].costPrice || 0);
          updateData.quantity = Number(units[0].quantity || 0);
        }
        await db().collection("products").doc(product._id).update({ data: updateData });
      }
    }
  },

  // 保存修改：统一处理改名→同步报表/进货/历史；按差额修正商品库库存/进价；同步日期/供应商。
  async onSave() {
    const { items, purchase } = this.data;
    if (!items.length) {
      wx.showToast({ title: "请至少保留一行明细", icon: "none" });
      return;
    }
    for (let i = 0; i < items.length; i++) {
      if (!items[i].name.trim()) {
        wx.showToast({ title: `第 ${i + 1} 行缺少商品名称`, icon: "none" });
        return;
      }
      if (Number(items[i].quantity) < 0) {
        wx.showToast({ title: `第 ${i + 1} 行数量不能为负数`, icon: "none" });
        return;
      }
    }
    const payloadItems = items.map((it) => ({
      name: it.name.trim(),
      unit: it.unit.trim() || "个",
      quantity: Number(it.quantity) || 0,
      price: roundMoney(Number(it.price) || 0),
      amount: roundMoney(Number(it.price || 0) * Number(it.quantity || 0)),
    }));
    const totalAmount = roundMoney(payloadItems.reduce((s, it) => s + it.amount, 0));
    const supplier = (purchase.supplier || "").trim();
    const date = purchase.date || fmtDate(new Date());
    this.setData({ saving: true });
    try {
      // 以数据库当前明细为基线（支持同一记录多次编辑）
      const oldRes = await db().collection("purchases").doc(this.purchaseId).get();
      const oldItems = (oldRes.data.items || []).map((it) => ({
        name: it.name || "",
        unit: it.unit || "个",
        quantity: Number(it.quantity) || 0,
        price: Number(it.price) || 0,
      }));

      // 1) 处理改名：行名相对 origName 变化 → 改名/合并，统一到商品库+报表+进货+历史
      const { renameOf, renamedCount } = await this.applyNameSyncs(items);

      // 2) 基线重映射：改名行的旧名对齐为新名，避免 syncStock 把改名当「旧删新增」双重计库存
      const baseline = oldItems.map((it) =>
        renameOf[it.name] ? { ...it, name: renameOf[it.name] } : it
      );

      wx.showLoading({ title: "保存中…" });
      // 3) 数量/单位/进价差额修正
      await this.syncStock(baseline, payloadItems, supplier);
      // 4) 日期/供应商同步到由本进货建档的商品
      await this.syncProductSource(date, supplier);
      // 5) 更新进货记录
      await db()
        .collection("purchases")
        .doc(this.purchaseId)
        .update({
          data: {
            supplier,
            date,
            items: payloadItems,
            totalAmount,
            itemCount: payloadItems.length,
            updateTime: db().serverDate(),
          },
        });
      // 6) 重建本发票涉及商品的数量（归入保存：按 发票/进货 − 报表 + 手动 重算库存；仅数量/单位变动时触发）
      await this.rebuildProductsForSave(baseline, payloadItems);
      wx.hideLoading();
      this.setData({ saving: false });
      wx.showToast({
        title: renamedCount ? `已保存，同步${renamedCount}处改名` : "已保存并修正库存",
        icon: "none",
      });
    } catch (e) {
      wx.hideLoading();
      this.setData({ saving: false });
      console.error("保存失败", e);
      wx.showToast({ title: "保存失败", icon: "none" });
    }
  },

  // 逐行处理改名：对 name 相对 origName 变化的行，改名并全局同步；撞上已存在同名商品则询问是否合并。
  // 返回 { renameOf: {旧名: 新名}, renamedCount }；并把本行 origName 更新为新名，避免下次保存重复触发。
  async applyNameSyncs(items) {
    const renameOf = {};
    let renamedCount = 0;
    for (const it of items) {
      const oldName = (it.origName || "").trim();
      const newName = (it.name || "").trim();
      if (!oldName || oldName === newName) continue;
      const drop = await this.findProductByName(oldName);
      if (!drop) continue; // 旧名从未作为商品入库，无改名对象
      const keep = await this.findProductByName(newName);
      let result;
      if (keep && keep._id !== drop._id) {
        // 撞名：询问是否合并
        result = await this.promptMergeDrop(drop, keep, oldName, newName);
      } else {
        const r = await callReportOps("syncProductName", {
          productId: drop._id,
          oldName,
          newName,
        });
        result = r.result;
      }
      if (result && result.success) {
        if (!renameOf[oldName]) renameOf[oldName] = newName;
        renamedCount++;
        it.origName = newName;
      }
    }
    return { renameOf, renamedCount };
  },

  // 撞名弹窗：确认=合并（并入 keep、移除 drop），取消=仅改名（保留重复商品）
  promptMergeDrop(drop, keep, oldName, newName) {
    return new Promise((resolve) => {
      wx.showModal({
        title: "发现同名商品",
        content: `系统已有商品「${newName}」。要将「${oldName}」的库存/进价合并到「${newName}」吗？\n\n「合并」会并入并移除错名商品；「仅改名」会保留一个重复商品。`,
        confirmText: "合并",
        cancelText: "仅改名",
        confirmColor: "#07c160",
        success: async (res) => {
          const payload = { productId: drop._id, oldName, newName };
          try {
            const r = res.confirm
              ? await callReportOps("mergeProduct", {
                  keepId: keep._id,
                  dropId: drop._id,
                  keepName: newName,
                  dropName: oldName,
                })
              : await callReportOps("syncProductName", payload);
            resolve(r.result);
          } catch (e) {
            console.error("改名/合并失败", e);
            resolve(null);
          }
        },
        fail: () => resolve(null), // 点遮罩取消：不处理
      });
    });
  },

  // 日期/供应商同步：由本进货建档的未合并商品，更新 source.date / source.supplier
  async syncProductSource(date, supplier) {
    const pageSize = 100;
    let offset = 0;
    for (;;) {
      const res = await db()
        .collection("products")
        .where({ "source.purchaseId": this.purchaseId })
        .skip(offset)
        .limit(pageSize)
        .get();
      if (!res.data || res.data.length === 0) break;
      for (const p of res.data) {
        if (p.deleted) continue;
        const src = p.source || {};
        await db().collection("products").doc(p._id).update({
          data: {
            source: {
              ...src,
              date: date || src.date || "",
              supplier: supplier !== undefined ? supplier : src.supplier,
            },
            updateTime: db().serverDate(),
          },
        });
      }
      offset += res.data.length;
      if (res.data.length < pageSize) break;
    }
  },

  // 按商品名找商品（排除已删回收站）
  async findProductByName(name) {
    if (!name) return null;
    const res = await db().collection("products").where({ name }).limit(1).get();
    const p = res.data[0];
    return p && !p.deleted ? p : null;
  },

  // 汇总 (名称,单位)->数量，用于判断哪些商品的数量/单位发生了变动
  _sumQtyByUnit(items) {
    const m = {};
    (items || []).forEach((it) => {
      const name = (it.name || "").trim();
      if (!name) return;
      const unit = (it.unit || "").trim() || "个";
      const k = name + " " + unit;
      m[k] = roundMoney((m[k] || 0) + (Number(it.quantity) || 0));
    });
    return m;
  },

  // 重建本发票涉及商品的数量（归入保存：按 发票/进货 − 报表 + 手动 重算库存）
  // 仅对保存前后「数量/单位」真正发生变动的商品后台重算；只改了名称/单价/供应商/日期则不触发。
  async rebuildProductsForSave(baselineItems, payloadItems) {
    const oldMap = this._sumQtyByUnit(baselineItems);
    const newMap = this._sumQtyByUnit(payloadItems);
    const keys = [...new Set([...Object.keys(oldMap), ...Object.keys(newMap)])];
    const changedNames = new Set();
    for (const k of keys) {
      const oldQty = oldMap[k] || 0;
      const newQty = newMap[k] || 0;
      if (Math.abs(oldQty - newQty) > 0.001) {
        changedNames.add(k.split(" ")[0]);
      }
    }
    for (const name of changedNames) {
      try {
        const product = await this.findProductByName(name);
        if (!product) continue;
        await callReportOps("rebuildQuantity", { productId: product._id, dryRun: false });
      } catch (e) {
        console.error(`重建 ${name} 数量失败`, e);
      }
    }
  },

  // 用它开报表：把当前明细带过去开新报表
  openReport() {
    const goodsItems = (this.data.items || [])
      .filter((it) => it.name && it.name.trim())
      .map((it) => ({
        type: "goods",
        name: it.name.trim(),
        unit: it.unit || "个",
        price: Number(it.price) || 0,
        quantity: Number(it.quantity) || 0,
      }));
    if (!goodsItems.length) {
      wx.showToast({ title: "没有可用的明细", icon: "none" });
      return;
    }
    getApp().globalData.reportDraft = {
      items: goodsItems,
      date: (this.data.purchase && this.data.purchase.date) || "",
    };
    wx.navigateTo({ url: "/pages/report-edit/report-edit" });
  },
});
