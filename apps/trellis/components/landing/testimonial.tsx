export function Testimonial() {
	return (
		<section className="py-20 md:py-28">
			<div className="container mx-auto px-4">
				<div className="max-w-[48rem] mx-auto text-center">
					<blockquote className="text-xl sm:text-2xl md:text-3xl font-medium tracking-tight text-foreground leading-snug italic">
						&ldquo;Trellis replaces weeks of Terraform boilerplate with
						a 20-minute visual workflow — across AWS, GCP, and
						Azure.&rdquo;
					</blockquote>
					<div className="mt-6 flex items-center justify-center gap-3">
						<div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center text-sm font-semibold text-muted-foreground">
							BB
						</div>
						<div className="text-left">
							<p className="text-sm font-medium text-foreground">
								Borislav Borisov
							</p>
							<p className="text-xs text-muted-foreground">
								Creator of Trellis
							</p>
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}
