/**
 * The Jackyun open-platform reference of the methods a company Jackyun connector may allow, as
 * Jackyun's own CLI (`jky-cli docs get`) publishes it: what `jackyun docs get` prints to the model.
 */

/** A request parameter: its type, what it means, and the fields of an object or of an array's items. */
export interface JackyunParam {
  readonly type: string
  readonly description?: string
  readonly items?: Readonly<Record<string, JackyunParam>>
  readonly properties?: Readonly<Record<string, JackyunParam>>
}

/** One method's reference. */
export interface JackyunMethodDoc {
  readonly summary: string
  readonly description: string
  readonly params: Readonly<Record<string, JackyunParam>>
}

/** The reference, by method. */
export const JACKYUN_DOCS: Readonly<Record<string, JackyunMethodDoc>> = {
  'erp.storage.goodslist': {
    'summary': '分页查询货品信息',
    'description': '首次同步，传参maxSkuId(前一次返回的最大skuId ，第一次传0，后面取前一次查询返回的 最后一条数据的skuId)，不用翻页（内部逻辑会取大于maxSkuId的数据）',
    'params': {
      'goodsNo': {
        'type': 'string',
        'description': '货品编号',
      },
      'skuCodes': {
        'type': 'string',
        'description': '外部编码(多个用逗号隔开)',
      },
      'endDate': {
        'type': 'string',
        'description': '货品创建结束时间',
      },
      'isPackageGood': {
        'type': 'integer',
        'description': '是否是组合装 1-是 0-否',
      },
      'endDateModifiedSku': {
        'type': 'string',
        'description': '终止时间(规格修改时间)',
      },
      'startDateModifiedGoods': {
        'type': 'string',
        'description': '起始时间(货品修改时间)',
      },
      'pageSize': {
        'type': 'integer',
        'description': '分页页数',
      },
      'cateName': {
        'type': 'string',
        'description': '分类名称',
      },
      'skuName': {
        'type': 'string',
        'description': '规格名称',
      },
      'skuIsBlockup': {
        'type': 'integer',
        'description': '规格是否停用（0：否；1：是）',
      },
      'goodsNos': {
        'type': 'string',
        'description': '货品编号,多个用,号隔开',
      },
      'isQueryDelete': {
        'type': 'string',
        'description': '是否需要返回已删除的货品 传1 需要  不传或者传0 不返回已删除的货品',
      },
      'maxSkuId': {
        'type': 'string',
        'description': '上次查询返回的 最大skuId(就是最后一条 skuId，首次传0)',
      },
      'endDateModifiedGoods': {
        'type': 'string',
        'description': '终止时间(货品修改时间)',
      },
      'isBlockup': {
        'type': 'integer',
        'description': '货品是否停用（0：否；1：是）',
      },
      'pageIndex': {
        'type': 'integer',
        'description': '分页页码',
      },
      'startDateModifiedSku': {
        'type': 'string',
        'description': '起始时间(规格修改时间)',
      },
      'skuBarcode': {
        'type': 'string',
        'description': '条码',
      },
      'abcCate': {
        'type': 'string',
        'description': 'ABC分类(A类,B类,C类)',
      },
      'assistBarcode': {
        'type': 'string',
        'description': '辅助条码（支持批量查询，使用,隔开）',
      },
      'goodsName': {
        'type': 'string',
        'description': '货品名称',
      },
      'startDate': {
        'type': 'string',
        'description': '货品创建起始时间',
      },
      'skuBarcodes': {
        'type': 'string',
        'description': '条码多个筛选，逗号隔开',
      },
    },
  },
  'erp-goods.goods.listgoodspackage': {
    'summary': '查询组合装信息',
    'description': '如果查询数据量超 1 万，为避免性能问题，建议按以下方式分批查询\n1、按修改时间分批， 每次查一个小时间范围（如 1天内）的数据，循环获取所有时段。\n2、按 ID 游标分批，首次传maxSkuId=0，之后每次传上批结果的最后一个skuId。',
    'params': {
      'goodsNo': {
        'type': 'string',
        'description': '货品编码',
      },
      'skuName': {
        'type': 'string',
        'description': '规格名称(多个用","号隔开)',
      },
      'pageSize': {
        'type': 'integer',
        'description': '分页页数（默认50），最大值200',
      },
      'skuBarCode': {
        'type': 'string',
        'description': '条码(多个用","号隔开)',
      },
      'pageIndex': {
        'type': 'integer',
        'description': '分页页码（默认0）',
      },
      'goodsName': {
        'type': 'string',
        'description': '货品名称(多个用","号隔开)',
      },
    },
  },
  'erp.packagegoods.import': {
    'summary': '添加组合装商品',
    'description': '支持新增和修改组合装，根据 货品编号 goodsNo定位货品。组合装规格只有一条，skuList 可以传一条或者不传即默认规格',
    'params': {
      'isBatchManagement': {
        'type': 'integer',
        'description': '是否批次管理',
      },
      'skuList': {
        'type': 'array',
        'description': '规格明细，没有明细则自动生成“默认规格”的sku',
        'items': {
          'skuName': {
            'type': 'string',
            'description': '规格名称，不输创建“默认规格”',
          },
          'skuHeight': {
            'type': 'string',
            'description': '高',
          },
          'skuLength': {
            'type': 'string',
            'description': '长',
          },
          'skuWidth': {
            'type': 'string',
            'description': '宽',
          },
          'skuBarcode': {
            'type': 'string',
            'description': '条码，条码存在则覆盖',
          },
          'skuWeight': {
            'type': 'string',
            'description': '重量（克）',
          },
        },
      },
      'goodsNameEn': {
        'type': 'string',
        'description': '货品英文名',
      },
      'costValuationMethod': {
        'type': 'integer',
        'description': '计价方式（0：移动加权平均；1：先进先出；2：个别计价；3：月末一次加权平均法；4：固定成本价；5：批内移动加权平均）',
      },
      'isPeriodManage': {
        'type': 'integer',
        'description': '有效期管理',
      },
      'cateName': {
        'type': 'string',
        'description': '货品的分类名称',
      },
      'isDoorService': {
        'type': 'integer',
        'description': '是否需上门安装（发货后转工单)（0：否；1：是）',
      },
      'isCustomizProduction': {
        'type': 'integer',
        'description': '是否定制生产（转生产后发货）（0：否；1：是）',
      },
      'packageSkuList': {
        'type': 'array',
        'description': '组合装的子件列表',
        'items': {
          'goodsAmount': {
            'type': 'string',
            'description': '子件数量',
          },
          'outSkuCode': {
            'type': 'string',
            'description': '外部编码',
          },
          'isGift': {
            'type': 'boolean',
            'description': '是否赠品 1-是 0-否',
          },
          'unitName': {
            'type': 'string',
            'description': '计量单位',
          },
          'sharePrice': {
            'type': 'string',
            'description': '分摊单价',
          },
          'skuBarcode': {
            'type': 'string',
            'description': '子件条码',
          },
        },
      },
      'goodsAlias': {
        'type': 'string',
        'description': '货品别名',
      },
      'isProxySale': {
        'type': 'integer',
        'description': '是否代销（转供应商发货）（0：否；1：是）',
      },
      'isSplitOrder': {
        'type': 'integer',
        'description': '采购不拆分(0-采购拆分 1-采购不拆分)',
      },
      'shelfLiftUnit': {
        'type': 'string',
        'description': '质保期的单位(年、月、天)，如果是有效期管理，此项必输',
      },
      'shelfLife': {
        'type': 'integer',
        'description': '质保期，如果是有效期管理，此项必输',
      },
      'goodsName': {
        'type': 'string',
        'description': '货品名称',
      },
      'goodsDesc': {
        'type': 'string',
        'description': '货品说明',
      },
      'goodsNo': {
        'type': 'string',
        'description': '货品编号，如果名字不存在编号存在则按编号更新',
      },
      'isSplitSale': {
        'type': 'integer',
        'description': '销售不拆分(0-销售拆分 1-销售不拆分)',
      },
      'brandName': {
        'type': 'string',
        'description': '品牌名称',
      },
      'unitName': {
        'type': 'string',
        'description': '计量单位',
      },
      'isStopPurchasing': {
        'type': 'integer',
        'description': '停止采购 1-是 0-否',
      },
      'isPaidService': {
        'type': 'integer',
        'description': '是否有偿服务（无库存管理）（0：否；1：是）',
      },
      'isPickupCard': {
        'type': 'integer',
        'description': '是否提货卡券（提货结算冲抵）（0：否；1：是）',
      },
      'goodsMemo': {
        'type': 'string',
        'description': '货品备注',
      },
      'cateCode': {
        'type': 'string',
        'description': '货品分类编码',
      },
      'isStopSelling': {
        'type': 'integer',
        'description': '停止销售 1-是 0-否',
      },
      'goodsAttr': {
        'type': 'integer',
        'description': '货品属性（1：成品；2：半成品；3：原料；4：包装材料；5：辅料；6：设备；7：备件；8：费用）',
      },
      'isSerialManagement': {
        'type': 'integer',
        'description': '是否序列号管理',
      },
      'isSplitAllocate': {
        'type': 'integer',
        'description': '调拨不拆分 1-是 0-否',
      },
      'isProsaleProduct': {
        'type': 'integer',
        'description': '是否预售品（转预售单）（0：否；1：是）',
      },
      'isProductionMaterials': {
        'type': 'integer',
        'description': '是否生产物料（0：否；1：是）',
      },
    },
  },
}
