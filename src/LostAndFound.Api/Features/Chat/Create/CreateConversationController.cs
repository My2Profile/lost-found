using LostAndFound.Api.Features.Chat;
using LostAndFound.Api.Features.Items;
using LostAndFound.Api.Infrastructure.Persistence;
using LostAndFound.Api.Features.Identity;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Identity.Web.Resource;
using MongoDB.Driver;

namespace LostAndFound.Api.Features.Chat.Create;

[ApiController]
[Route("api/conversations")]
[Authorize]
[RequiredScope("access_as_user")]
public sealed class CreateConversationController(
    AppDbContext db,
    ChatDbContext chatDb) : ControllerBase
{
    [HttpPost]
    public async Task<IActionResult> Create(
        [FromBody] CreateConversationRequest request,
        CancellationToken cancellationToken)
    {
        if (User.GetUserId() is not { } userId)
        {
            return Unauthorized();
        }

        if (request.FoundItemId == Guid.Empty)
        {
            return BadRequest(new
            {
                message = "Укажите ID объявления."
            });
        }

        var item = await db.FoundItems
            .AsNoTracking()
            .Where(x => x.Id == request.FoundItemId)
            .Select(x => new
            {
                x.Id,
                x.UserFoundId,
                x.FinderName,
                x.Status
            })
            .SingleOrDefaultAsync(cancellationToken);

        if (item is null)
        {
            return NotFound(new
            {
                message = "Объявление не найдено."
            });
        }

        if (item.UserFoundId == userId)
        {
            return BadRequest(new
            {
                message = "Нельзя создать диалог с самим собой."
            });
        }

        var filter = Builders<Conversation>.Filter.And(
            Builders<Conversation>.Filter.Eq(
                x => x.FoundItemId, item.Id),
            Builders<Conversation>.Filter.Eq(
                x => x.InitiatorUserId, userId));

        var existing = await chatDb.Conversations
            .Find(filter)
            .FirstOrDefaultAsync(cancellationToken);

        if (existing is not null)
        {
            // "This is mine" again after deleting the chat: show it again.
            await chatDb.Conversations.UpdateOneAsync(
                Builders<Conversation>.Filter.Eq(x => x.Id, existing.Id),
                Builders<Conversation>.Update.Pull(x => x.HiddenFor, userId.ToString()),
                cancellationToken: cancellationToken);

            return Ok(ToResponse(existing));
        }

        if (item.Status != FoundItemStatus.Open)
        {
            return Conflict(new
            {
                message = "Вещь уже возвращена, новый чат открыть нельзя."
            });
        }

        var conversation = new Conversation
        {
            FoundItemId = item.Id,
            OwnerUserId = item.UserFoundId,
            InitiatorUserId = userId,
            OwnerName = item.FinderName,
            InitiatorName = User.GetDisplayName()
        };

        try
        {
            await chatDb.Conversations.InsertOneAsync(
                conversation,
                cancellationToken: cancellationToken);
        }
        catch (MongoWriteException exception)
            when (exception.WriteError.Category ==
                  ServerErrorCategory.DuplicateKey)
        {
            // Другой запрос успел создать этот же диалог.
            var created = await chatDb.Conversations
                .Find(filter)
                .FirstOrDefaultAsync(cancellationToken);

            if (created is null)
            {
                throw;
            }

            return Ok(ToResponse(created));
        }

        return StatusCode(
            StatusCodes.Status201Created,
            ToResponse(conversation));
    }

    private static CreateConversationResponse ToResponse(
        Conversation conversation)
    {
        return new CreateConversationResponse(
            conversation.Id,
            conversation.FoundItemId,
            conversation.OwnerUserId,
            conversation.InitiatorUserId,
            conversation.CreatedAt);
    }
}

public sealed record CreateConversationRequest(Guid FoundItemId);

public sealed record CreateConversationResponse(
    Guid Id,
    Guid FoundItemId,
    Guid OwnerUserId,
    Guid InitiatorUserId,
    DateTime CreatedAt);