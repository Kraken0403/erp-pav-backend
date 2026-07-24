const parseBooleanEnv = (value, fallback = false) => {
    if (value === undefined || value === null || String(value).trim() === '') {
        return fallback;
    }

    const normalized = String(value).trim().toLowerCase();

    if (['true', '1', 'yes', 'y', 'on', 'enabled', 'enable'].includes(normalized)) {
        return true;
    }

    if (['false', '0', 'no', 'n', 'off', 'disabled', 'disable'].includes(normalized)) {
        return false;
    }

    return fallback;
};

const isEmailEnabled = () => parseBooleanEnv(process.env.ALLOW_EMAIL, true);
const isWhatsAppEnabled = () => parseBooleanEnv(process.env.ALLOW_WHATSAPP, true);
const isRazorpayEnabled = () => parseBooleanEnv(process.env.ALLOW_RAZORPAY, true);

module.exports = {
    parseBooleanEnv,
    isEmailEnabled,
    isWhatsAppEnabled,
    isRazorpayEnabled,
};
