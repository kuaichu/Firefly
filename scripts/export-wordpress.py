"""Run on the WordPress host; export public content only, without WP credentials."""
import json
import subprocess


def query(sql):
    data = subprocess.check_output(
        ["mariadb", "--default-character-set=utf8mb4", "--batch", "--raw",
         "--skip-column-names", "wordpress", "-e", sql], text=True
    )
    return [json.loads(line) for line in data.splitlines() if line]


result = {
    "posts": query("""SELECT JSON_OBJECT(
        'id', ID, 'title', post_title, 'slug', post_name, 'content', post_content,
        'excerpt', post_excerpt, 'published', post_date, 'modified', post_modified,
        'publishedGmt', post_date_gmt, 'modifiedGmt', post_modified_gmt)
        FROM wp_posts WHERE post_type='post' AND post_status='publish' ORDER BY ID"""),
    "terms": query("""SELECT JSON_OBJECT('id', t.term_id, 'name', t.name,
        'slug', t.slug, 'taxonomy', tt.taxonomy, 'taxonomyId', tt.term_taxonomy_id)
        FROM wp_terms t JOIN wp_term_taxonomy tt ON tt.term_id=t.term_id
        WHERE tt.taxonomy IN ('category','post_tag')"""),
    "relationships": query("""SELECT JSON_OBJECT('postId', object_id,
        'taxonomyId', term_taxonomy_id) FROM wp_term_relationships"""),
    "metadata": query("""SELECT JSON_OBJECT('postId', post_id,
        'key', meta_key, 'value', meta_value) FROM wp_postmeta
        WHERE meta_key IN ('_thumbnail_id','game_year','_wp_attached_file','_wp_old_slug')"""),
    "attachments": query("""SELECT JSON_OBJECT('id', ID, 'title', post_title,
        'mime', post_mime_type) FROM wp_posts WHERE post_type='attachment'"""),
}
print(json.dumps(result, ensure_ascii=False))
