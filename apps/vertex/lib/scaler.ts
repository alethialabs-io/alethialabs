/** Fire-and-forget ping to the Lambda scaler so it checks for queued jobs immediately. */
export function notifyScaler() {
	const url = process.env.SCALER_FUNCTION_URL;
	if (!url) return;
	fetch(url, { method: "POST" }).catch(() => {});
}
