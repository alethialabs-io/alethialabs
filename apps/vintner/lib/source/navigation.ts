export function getSection(path: string | undefined) {
	if (!path) return "trellis";
	const [dir] = path.split("/", 1);
	if (!dir) return "trellis";
	return (
		{
			trellis: "trellis",
			grape: "grape",
			tendril: "tendril",
			concepts: "concepts",
		}[dir] ?? "trellis"
	);
}