/* Kyros in the block checkout: a payment option whose payment happens on the order's payment page. */
(function () {
  var registry = window.wc && window.wc.wcBlocksRegistry;
  var settings = (window.wc && window.wc.wcSettings && window.wc.wcSettings.getSetting('kyros_data', {})) || {};
  if (!registry || !window.wp || !window.wp.element) return;
  var el = window.wp.element.createElement;
  var decode = (window.wp.htmlEntities && window.wp.htmlEntities.decodeEntities) || function (s) { return s; };
  var title = decode(settings.title || 'Pay with USDC on Stellar');
  var Content = function () { return el('p', null, decode(settings.description || '')); };
  registry.registerPaymentMethod({
    name: 'kyros',
    label: el('span', null, title),
    ariaLabel: title,
    content: el(Content),
    edit: el(Content),
    canMakePayment: function () { return true; },
    supports: { features: ['products'] },
  });
})();
