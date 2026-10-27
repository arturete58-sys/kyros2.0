/**
 * Thank you page: when the buyer chose the manual payment method, a button
 * (and a QR code, to pay from a phone wallet) to the order's Kyros payment page.
 */
import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useSelectedPaymentOptions, useSettings, useTranslate } from '@shopify/ui-extensions/checkout/preact';

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const t = useTranslate();
  const { pay_url: payUrl } = useSettings<{ pay_url?: string }>();
  const manual = useSelectedPaymentOptions().some((o) => o.type === 'manualPayment');
  const order = shopify.orderConfirmation.value;
  if (!payUrl || !manual || !order?.number) return null;
  const id = order.order.id.split('/').pop();
  const href = `${payUrl.replace(/\/$/, '')}/pay/${id}?n=${encodeURIComponent(order.number)}`;
  return (
    <s-stack gap="base">
      <s-heading>{t('title')}</s-heading>
      <s-paragraph>{t('body')}</s-paragraph>
      <s-button href={href} target="_blank" variant="primary">
        {t('pay')}
      </s-button>
      <s-qr-code content={href} accessibilityLabel={t('qr')} />
    </s-stack>
  );
}
