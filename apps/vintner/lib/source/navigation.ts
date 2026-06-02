export function getSection(path: string | undefined) {
	if (!path) return "architecture";
	const [dir] = path.split("/", 1);
	if (!dir) return "architecture";
	return (
		{
			architecture: "architecture",
			grape: "grape",
			trellis: "trellis",
			tendril: "tendril",
		}[dir] ?? "architecture"
	);
}