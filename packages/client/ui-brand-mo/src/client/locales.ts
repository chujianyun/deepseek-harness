/** MO brand copy: the new-session quick tasks. */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  quickTasks: '快捷任务',
  'multi-publish.title': '多店铺发品',
  'multi-publish.description': '同一款新品一次发到天猫、拼多多、抖店草稿',
  'multi-publish.prompt': '帮我把一款新品发到多个店铺（天猫、拼多多、抖店），先存为草稿。新品素材文件夹是：',
  'business-report.title': '生意参谋核心日报',
  'business-report.description': '导出昨日店铺核心指标并生成日报',
  'business-report.prompt': '帮我导出昨天生意参谋的店铺核心指标，生成一份可以直接转发的日报。店铺是：',
  'product-research.title': '单品采集报告',
  'product-research.description': '给商品链接，整理竞品详情、价格与评价',
  'product-research.prompt': '帮我采集这个商品的详情、价格和评价，整理成一份单品报告。商品链接是：',
  'asset-organize.title': '商品素材整理',
  'asset-organize.description': '把图片、SKU 表整理成发品素材包',
  'asset-organize.prompt': '帮我把这个文件夹里的商品图片和 SKU 表整理成标准的发品素材包。文件夹是：',
}

/** Locale key of the MO brand dictionary. */
export type BrandLocaleKey = keyof typeof zh

/** English dictionary. */
export const en: Record<BrandLocaleKey, string> = {
  quickTasks: 'Quick tasks',
  'multi-publish.title': 'Publish to several stores',
  'multi-publish.description': 'Send one new product to Tmall, Pinduoduo, and Douyin drafts at once',
  'multi-publish.prompt': 'Publish one new product to several stores (Tmall, Pinduoduo, Douyin) and save it as drafts. The product asset folder is: ',
  'business-report.title': 'Business advisor daily report',
  'business-report.description': "Export yesterday's core store metrics as a daily report",
  'business-report.prompt': "Export yesterday's core store metrics from Business Advisor and write a daily report I can forward. The store is: ",
  'product-research.title': 'Product research report',
  'product-research.description': 'From a product link, collect details, prices, and reviews',
  'product-research.prompt': 'Collect the details, price, and reviews of this product and write a product report. The product link is: ',
  'asset-organize.title': 'Organize product assets',
  'asset-organize.description': 'Turn images and SKU sheets into a publishing asset pack',
  'asset-organize.prompt': 'Organize the product images and SKU sheet in this folder into a standard publishing asset pack. The folder is: ',
}
