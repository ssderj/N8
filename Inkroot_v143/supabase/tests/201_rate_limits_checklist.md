# F11 checklist — run on a Supabase BRANCH first (migration 201 was never executed)
Use a normal signed-in test user via the app or a client with their JWT, not the SQL editor (the SQL editor has no auth.uid(), so the triggers skip it by design).
1. Apply 201. Normal use still works: publish a book, review it, follow an author, post, react, report.
2. Editing is free: re-publish / edit the same book 40 times in an hour -> never blocked. Edit your review 40 times -> never blocked. Re-follow the same author -> never blocked.
3. New listings count: publish 30 NEW books in an hour (script or temporary lower limit) -> the 31st fails "Too many requests — please slow down and try again shortly." (To test quickly: temporarily set 'publish_listing' to 2 in the function, then restore.)
4. A guild anthology publish (publish_guild_anthology) still works and counts as one listing.
5. Reactions: toggle a reaction on/off repeatedly; blocked only after 200 inserts in an hour.
6. `select user_id, action, call_count from api_rate_limits order by window_start desc limit 10;` shows the new actions after a few writes.
7. A service-role / SQL-editor insert into reviews (or any limited table) is NOT blocked and does not error with "Not signed in".
8. Anonymous views: signed-out, fire 300+ record_book_view calls across different books inside a minute -> rows stop being added after 300; no error is returned.
9. Existing storage-upload limit and join_guild / quiz_suggest limits still behave as before.
