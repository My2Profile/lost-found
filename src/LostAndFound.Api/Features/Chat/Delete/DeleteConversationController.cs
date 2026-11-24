using LostAndFound.Api.Features.Identity;
using LostAndFound.Api.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Identity.Web.Resource;
using MongoDB.Driver;

namespace LostAndFound.Api.Features.Chat.Delete;

/// <summary>
/// DELETE /api/conversations/{id}: removes the chat from the caller's list.
/// The other person keeps it. When both have deleted it, the chat and its messages are removed.
/// </summary>
[ApiController]
[Route("api/conversations")]
[Authorize]
[RequiredScope("access_as_user")]
public sealed class DeleteConversationController(ChatDbContext db) : ControllerBase
{
    [HttpDelete("{conversationId:guid}")]
    public async Task<IActionResult> Delete(Guid conversationId, CancellationToken cancellationToken)
    {
        if (User.GetUserId() is not { } userId)
        {
            return Unauthorized();
        }

        var filters = Builders<Conversation>.Filter;
        var filter = filters.And(
            filters.Eq(x => x.Id, conversationId),
            filters.Or(
                filters.Eq(x => x.OwnerUserId, userId),
                filters.Eq(x => x.InitiatorUserId, userId)));

        var updated = await db.Conversations.FindOneAndUpdateAsync(
            filter,
            Builders<Conversation>.Update.AddToSet(x => x.HiddenFor, userId.ToString()),
            new FindOneAndUpdateOptions<Conversation> { ReturnDocument = ReturnDocument.After },
            cancellationToken);

        if (updated is null)
        {
            return NotFound();
        }

        var hiddenForBoth =
            updated.HiddenFor.Contains(updated.OwnerUserId.ToString())
            && updated.HiddenFor.Contains(updated.InitiatorUserId.ToString());

        if (hiddenForBoth)
        {
            await db.Messages.DeleteManyAsync(
                Builders<ChatMessage>.Filter.Eq(x => x.ConversationId, conversationId),
                cancellationToken);
            await db.Conversations.DeleteOneAsync(
                filters.Eq(x => x.Id, conversationId),
                cancellationToken);
        }

        return NoContent();
    }
}
