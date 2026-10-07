---
layout: default
title: QA
permalink: /categories/qa/
---
<section class="category-page"><div class="category-page-heading"><div><p class="eyebrow">LEARNING TRACK 01</p><h1>QA</h1><p class="category-description">테스트 자동화와 품질 검증을 배우며 정리합니다.</p></div><label class="article-search"><span class="sr-only">QA 아티클 검색</span><input type="search" data-article-search placeholder="QA 글 검색" autocomplete="off"></label></div><div class="post-list">{% for post in site.posts %}{% if post.categories contains 'qa' %}<article class="post-card" data-categories="qa" data-search="{{ post.title | escape }} {{ post.excerpt | strip_html | escape }} {{ post.tags | join: ' ' | escape }}"><a href="{{ post.url | relative_url }}"><div class="post-meta"><span>QA</span><time>{{ post.date | date: '%Y.%m.%d' }}</time></div><h3>{{ post.title }}</h3><p>{{ post.excerpt | strip_html | truncate: 140 }}</p><span class="read-more">Read article ↗</span></a></article>{% endif %}{% endfor %}</div><p class="article-search-empty" data-search-empty hidden>검색 결과가 없습니다.</p><nav class="pagination" data-pagination aria-label="QA 아티클 페이지"></nav></section><script src="{{ '/assets/js/filter.js' | relative_url }}"></script>
