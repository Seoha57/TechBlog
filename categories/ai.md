---
layout: default
title: AI
permalink: /categories/ai/
---

<section class="category-page"><div class="category-page-heading"><div><p class="eyebrow">LEARNING TRACK 04</p><h1>AI</h1><p class="category-description">LLM과 AI 에이전트의 기본 개념, 업무 적용과 검증 방법을 배우며 정리합니다.</p></div><label class="article-search"><span class="sr-only">AI 아티클 검색</span><input type="search" data-article-search placeholder="AI 글 검색" autocomplete="off"></label></div><div class="post-list">{% for post in site.posts %}{% if post.categories contains 'ai' %}<article class="post-card" data-categories="ai" data-search="{{ post.title | escape }} {{ post.excerpt | strip_html | escape }} {{ post.tags | join: ' ' | escape }}"><a href="{{ post.url | relative_url }}"><div class="post-meta"><span>AI</span><time>{{ post.date | date: '%Y.%m.%d' }}</time></div><h3>{{ post.title }}</h3><p>{{ post.excerpt | strip_html | truncate: 140 }}</p><span class="read-more">Read article ↗</span></a></article>{% endif %}{% endfor %}</div><p class="article-search-empty" data-search-empty hidden>검색 결과가 없습니다.</p></section><script src="{{ '/assets/js/filter.js' | relative_url }}"></script>
