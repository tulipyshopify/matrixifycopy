/**
 * A small stand-in for a Shopify store's products, for import tests: answers
 * the importer's lookups from its state and applies its writes to that state,
 * so a test can read back what an import really did.
 */
export interface FakeVariant {
  id: string;
  sku: string | null;
  price: string;
  compareAtPrice: string | null;
  barcode: string | null;
  options: Record<string, string>;
  tracked: boolean;
  /** location name -> available */
  stock: Record<string, number>;
  metafields: Record<string, { type: string; value: string }>;
}

export interface FakeProduct {
  id: string;
  handle: string;
  title: string;
  descriptionHtml: string;
  vendor: string;
  productType: string;
  status: string;
  tags: string[];
  published: boolean;
  images: string[];
  metafields: Record<string, { type: string; value: string }>;
  variants: FakeVariant[];
}

let seq = 1000;
const next = () => String(++seq);

export function variant(sku: string | null, price: string, options: Record<string, string> = {}, extra: Partial<FakeVariant> = {}): FakeVariant {
  return { id: `gid://shopify/ProductVariant/${next()}`, sku, price, compareAtPrice: null, barcode: null, options, tracked: true, stock: {}, metafields: {}, ...extra };
}

export function product(handle: string, title: string, variants: FakeVariant[], extra: Partial<FakeProduct> = {}): FakeProduct {
  return {
    id: `gid://shopify/Product/${next()}`,
    handle,
    title,
    descriptionHtml: `<p>${title}</p>`,
    vendor: "Woven Wood",
    productType: "Planters",
    status: "ACTIVE",
    tags: ["garden", "outdoor"],
    published: true,
    images: [],
    metafields: {},
    variants,
    ...extra,
  };
}

export function fakeStore(products: FakeProduct[], locationNames = ["Warehouse"]) {
  const locations = locationNames.map((name, i) => ({ id: `gid://shopify/Location/${i + 1}`, name, isActive: true }));
  const calls: Array<{ op: string; vars: any }> = [];
  const invId = (v: FakeVariant) => v.id.replace("ProductVariant", "InventoryItem");
  const find = (id: string) => products.find((p) => p.id === id);
  const variantNode = (p: FakeProduct, v: FakeVariant, i: number) => {
    const names = Object.keys(v.options);
    return {
      id: v.id,
      sku: v.sku,
      position: i + 1,
      barcode: v.barcode,
      price: v.price,
      compareAtPrice: v.compareAtPrice,
      taxable: true,
      taxCode: null,
      inventoryPolicy: "DENY",
      inventoryQuantity: Object.values(v.stock).reduce((a, b) => a + b, 0),
      image: null,
      selectedOptions: names.length ? names.map((n) => ({ name: n, value: v.options[n] })) : [{ name: "Title", value: "Default Title" }],
      inventoryItem: {
        id: invId(v),
        tracked: v.tracked,
        requiresShipping: true,
        harmonizedSystemCode: null,
        countryCodeOfOrigin: null,
        provinceCodeOfOrigin: null,
        unitCost: null,
        measurement: { weight: { value: 1, unit: "KILOGRAMS" } },
        inventoryLevels: { nodes: Object.keys(v.stock).map((n) => ({ location: { id: locations.find((l) => l.name === n)!.id } })) },
      },
    };
  };
  const productNode = (p: FakeProduct | undefined) => {
    if (!p) return null;
    const names = Object.keys(p.variants[0]?.options ?? {});
    return {
      id: p.id,
      handle: p.handle,
      title: p.title,
      hasOnlyDefaultVariant: !names.length,
      descriptionHtml: p.descriptionHtml,
      vendor: p.vendor,
      productType: p.productType,
      status: p.status,
      tags: p.tags,
      templateSuffix: null,
      publishedAt: p.published ? "2026-01-01T00:00:00Z" : null,
      seo: { title: null, description: null },
      category: null,
      options: names.length ? names.map((n, i) => ({ id: `o${i}`, name: n, position: i + 1, optionValues: [] })) : [{ id: "o", name: "Title", position: 1, optionValues: [] }],
      media: { nodes: p.images.map((url, i) => ({ id: `gid://shopify/MediaImage/${p.id.split("/").pop()}${i}`, alt: "", mediaContentType: "IMAGE", image: { url } })) },
    };
  };
  const ok = (x: object) => ({ ...x, userErrors: [] });
  const setVariant = (p: FakeProduct, input: any, v: FakeVariant) => {
    if (input.price !== undefined) v.price = Number(input.price).toFixed(2);
    if (input.compareAtPrice !== undefined) v.compareAtPrice = input.compareAtPrice === null ? null : Number(input.compareAtPrice).toFixed(2);
    if (input.barcodes !== undefined) v.barcode = input.barcodes[0]?.value ?? null;
    if (input.inventoryItem?.sku !== undefined) v.sku = input.inventoryItem.sku || null;
    if (input.inventoryItem?.tracked !== undefined) v.tracked = input.inventoryItem.tracked;
    for (const o of input.optionValues ?? []) v.options[o.optionName] = o.name;
    for (const m of input.metafields ?? []) v.metafields[`${m.namespace}.${m.key}`] = { type: m.type, value: m.value };
  };

  const handlers: Record<string, (v: any) => any> = {
    ImportProductByHandle: (v) => ({ productByIdentifier: productNode(products.find((p) => p.handle === v.handle.toLowerCase())) }),
    ImportProductById: (v) => ({ product: productNode(find(v.id)) }),
    ImportProductVariants: (v) => ({ product: { variants: { nodes: find(v.id)!.variants.map((x, i) => variantNode(find(v.id)!, x, i)), pageInfo: { hasNextPage: false, endCursor: null } } } }),
    ImportVariantProduct: (v) => {
      const p = products.find((x) => x.variants.some((y) => y.id === v.id));
      return { productVariant: p ? { id: v.id, product: { id: p.id } } : null };
    },
    ImportVariantsByBarcode: (v) => {
      const wanted = new Set([...String(v.query).matchAll(/barcode:"([^"]*)"/g)].map((m) => m[1]));
      return { productVariants: { nodes: products.flatMap((p) => p.variants.filter((x) => x.barcode && wanted.has(x.barcode)).map((x) => ({ id: x.id, barcode: x.barcode }))), pageInfo: { hasNextPage: false } } };
    },
    ImportVariantsBySku: (v) => {
      const sku = /sku:"(.*)"$/.exec(v.query)?.[1];
      return { productVariants: { nodes: products.flatMap((p) => p.variants.filter((x) => x.sku === sku).map((x) => ({ id: x.id, sku: x.sku, product: { id: p.id, handle: p.handle } }))), pageInfo: { hasNextPage: false } } };
    },
    ImportProductMetafieldsNow: (v) => ({ product: { metafields: { nodes: Object.entries(find(v.id)!.metafields).filter(([k]) => v.keys.includes(k)).map(([k, m]) => ({ namespace: k.split(".")[0], key: k, ...m })) } } }),
    ImportVariantMetafieldsNow: (v) => ({
      nodes: v.ids.map((id: string) => {
        const x = products.flatMap((p) => p.variants).find((y) => y.id === id);
        return x ? { id, metafields: { nodes: Object.entries(x.metafields).filter(([k]) => v.keys.includes(k)).map(([k, m]) => ({ namespace: k.split(".")[0], key: k, ...m })) } } : null;
      }),
    }),
    ImportStockNow: (v) => ({
      nodes: v.ids.map((id: string) => {
        const x = products.flatMap((p) => p.variants).find((y) => invId(y) === id);
        return x ? { id, inventoryLevels: { nodes: Object.entries(x.stock).map(([name, q]) => ({ location: locations.find((l) => l.name === name), quantities: v.names.map((n: string) => ({ name: n, quantity: n === "available" || n === "on_hand" ? q : 0 })) })) } } : null;
      }),
    }),
    Locations: () => ({ locations: { nodes: locations, pageInfo: { hasNextPage: false } } }),
    Publications: () => ({ publications: { nodes: [{ id: "gid://shopify/Publication/1", name: "Online Store", catalog: { title: "Online Store" } }] } }),
    ImportRecogniseProductHandle: (v) => ({ products: { nodes: products.filter((p) => `handle:"${p.handle}"` === v.q).map((p) => ({ id: p.id })) } }),
    ImportRecogniseCollectionHandle: () => ({ collections: { nodes: [] } }),
    ImportRecognisePageHandle: () => ({ pages: { nodes: [] } }),
    ImportRecogniseById: () => ({ nodes: [] }),
    ImportRecogniseByMetafield: () => ({ metafieldDefinitions: { nodes: [] } }),

    ImportProductUpdate: (v) => {
      const p = find(v.product.id)!;
      const { id: _id, seo: _seo, category: _c, ...fields } = v.product;
      Object.assign(p, fields);
      return { productUpdate: ok({ product: { id: p.id, handle: p.handle } }) };
    },
    ImportProductDelete: (v) => {
      products.splice(products.findIndex((p) => p.id === v.id), 1);
      return { productDelete: ok({ deletedProductId: v.id }) };
    },
    ImportProductSet: (v) => {
      const names = (v.input.productOptions ?? []).map((o: any) => o.name).filter((n: string) => n !== "Title");
      const p = product(v.input.handle ?? `new-${next()}`, v.input.title, [], { status: v.input.status ?? "ACTIVE", tags: v.input.tags ?? [], vendor: v.input.vendor ?? "", productType: v.input.productType ?? "", published: false, descriptionHtml: v.input.descriptionHtml ?? "" });
      p.variants = v.input.variants.map((x: any) => {
        const nv = variant(x.sku ?? null, Number(x.price ?? 0).toFixed(2), Object.fromEntries(names.map((n: string) => [n, x.optionValues.find((o: any) => o.optionName === n)?.name])));
        return nv;
      });
      products.push(p);
      return { productSet: ok({ product: { id: p.id, handle: p.handle, variants: { nodes: p.variants.map((x, i) => variantNode(p, x, i)) } } }) };
    },
    ImportVariantsUpdate: (v) => {
      const p = find(v.productId)!;
      for (const input of v.variants) setVariant(p, input, p.variants.find((x) => x.id === input.id)!);
      return { productVariantsBulkUpdate: ok({ productVariants: [] }) };
    },
    ImportVariantsCreate: (v) => {
      const p = find(v.productId)!;
      const made = v.variants.map((input: any) => {
        const nv = variant(null, "0.00");
        setVariant(p, input, nv);
        p.variants.push(nv);
        return { id: nv.id, selectedOptions: [], inventoryItem: { id: invId(nv) } };
      });
      return { productVariantsBulkCreate: ok({ productVariants: made }) };
    },
    ImportVariantsDelete: (v) => {
      const p = find(v.productId)!;
      p.variants = p.variants.filter((x) => !v.variantsIds.includes(x.id));
      return { productVariantsBulkDelete: ok({}) };
    },
    ImportProductMedia: (v) => {
      const p = find(v.productId)!;
      p.images.push(...v.media.map((m: any) => m.originalSource));
      return { productCreateMedia: { media: v.media.map((_: any, i: number) => ({ id: `gid://shopify/MediaImage/n${i}`, alt: "" })), mediaUserErrors: [] } };
    },
    ImportProductMediaDelete: () => ({ productDeleteMedia: { deletedMediaIds: [], mediaUserErrors: [] } }),
    MetafieldsSet: (v) => {
      for (const m of v.metafields) {
        const p = find(m.ownerId);
        if (p) p.metafields[`${m.namespace}.${m.key}`] = { type: m.type, value: m.value };
      }
      return { metafieldsSet: ok({}) };
    },
    MetafieldsDelete: (v) => {
      for (const m of v.metafields) delete find(m.ownerId)?.metafields[`${m.namespace}.${m.key}`];
      return { metafieldsDelete: ok({}) };
    },
    TagsAdd: (v) => (find(v.id)!.tags.push(...v.tags), { tagsAdd: ok({}) }),
    TagsRemove: (v) => {
      const p = find(v.id)!;
      p.tags = p.tags.filter((t) => !v.tags.includes(t));
      return { tagsRemove: ok({}) };
    },
    Publish: (v) => ((find(v.id)!.published = true), { publishablePublish: ok({}) }),
    Unpublish: (v) => ((find(v.id)!.published = false), { publishableUnpublish: ok({}) }),
    ImportInventoryActivate: () => ({ inventoryActivate: ok({}) }),
    ImportInventorySet: (v) => {
      for (const q of v.input.quantities) {
        const x = products.flatMap((p) => p.variants).find((y) => invId(y) === q.inventoryItemId)!;
        // Like Shopify: an untracked item accepts the write but holds no stock.
        if (x.tracked) x.stock[locations.find((l) => l.id === q.locationId)!.name] = q.quantity;
      }
      return { inventorySetQuantities: ok({}) };
    },
    ImportInventoryAdjust: (v) => {
      for (const c of v.input.changes) {
        const x = products.flatMap((p) => p.variants).find((y) => invId(y) === c.inventoryItemId)!;
        const loc = locations.find((l) => l.id === c.locationId)!.name;
        if (x.tracked) x.stock[loc] = (x.stock[loc] ?? 0) + c.delta;
      }
      return { inventoryAdjustQuantities: ok({}) };
    },
  };

  const gql = (async (q: string, v: any = {}) => {
    const m = /(query|mutation)\s+(\w+)/.exec(q)!;
    calls.push({ op: m[2], vars: v, kind: m[1] } as any);
    if (!handlers[m[2]]) throw new Error(`Unexpected operation ${m[2]}`);
    return handlers[m[2]](v);
  }) as any;

  return { gql, calls, products, locations, handlers, mutations: () => (calls as any[]).filter((c) => c.kind === "mutation").map((c) => c.op), byHandle: (h: string) => products.find((p) => p.handle === h) };
}
