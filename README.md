# Group Admin Bot

WhatsApp group moderation bot built for GitHub + Railway.

## Features
- Admin-only kick, add, mute/unmute, lock/unlock, rename and group-picture commands.
- Automatic link, insult and sticker moderation.
- 3 warnings then automatic kick.
- Welcome message.
- Member games: `/العاب`, `/نرد`, `/حظ`.
- Group picture: send/reply to an image with `/تغيير_الصورة`.

## Railway
1. Upload this folder to GitHub.
2. Create a Railway service from the GitHub repo.
3. Deploy with `npm start`.
4. Open logs and scan the WhatsApp QR code.
5. Keep the `auth` folder persistent if your Railway setup supports a volume. Otherwise the QR may be required again after redeploys.

## Important
The bot must be a group admin for moderation, participant updates, changing group subject and changing the group picture.
