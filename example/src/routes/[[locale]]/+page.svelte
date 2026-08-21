<script lang="ts">
	let { data } = $props();
</script>

<svelte:head>
	<title>{data.title}</title>
	<meta name="description" content={data.tagline} />
	<meta property="og:title" content={data.title} />
</svelte:head>

<main>
	<!-- Everything below is rendered from t() during SSR, so it is present in the
	     served bytes. That is the acceptance test: a crawler fetching /it receives
	     Italian body copy, not English with a catalog attached. -->
	<h1 data-testid="title">{data.title}</h1>
	<p data-testid="tagline">{data.tagline}</p>
	<p data-testid="greeting">{data.greeting}</p>
	<p data-testid="bottles">{data.bottles}</p>

	<img src="/water.png" alt={data.imageAlt} data-testid="image" />

	<nav>
		<a href="/" data-testid="cta">{data.cta}</a>
		<a href="/#guide" data-testid="guide">{data.guide}</a>
	</nav>

	<footer>
		<a href="/">en</a> · <a href="/it">it</a> · <a href="/de">de</a> · <a href="/ru">ru</a>
	</footer>
</main>
